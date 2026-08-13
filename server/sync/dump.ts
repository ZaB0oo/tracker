/**
 * Catalog verification against an official data.ppy.sh dump.
 *
 * The per-mode search enumeration cannot see delisted/DMCA sets, and the
 * beatmap packs turned out to miss most of them. The monthly dumps
 * (https://data.ppy.sh, e.g. performance_catch_top_1000.tar.bz2) contain the
 * FULL osu_beatmaps table — every ranked/approved/loved diff of every mode,
 * DMCA'd included — so diffing it against the local catalog gives the exact
 * per-mode holes. The missing sets are then re-imported by direct lookup
 * (which answers for DMCA'd sets).
 *
 * Accepted files: the .tar.bz2 dump as downloaded, or an already-extracted
 * osu_beatmaps.sql (faster: pure-JS bzip2 is slow on multi-GB archives).
 */
import fs from "node:fs";
import { getDb, getStartedRulesets } from "../db/db.js";
import { poolGrowth, rulesetDef } from "../logic/rulesets.js";
import { importOneSet, poolCounts } from "./catalog.js";
import { parseOsuBeatmapsSql } from "./dumpParse.js";

/**
 * Opens the picked file as an osu_beatmaps.sql stream (.sql / .sql.bz2 /
 * .tar.bz2), with a byte-level heartbeat so the UI can show that a multi-GB
 * read/decompression is alive.
 */
async function openDump(
  path: string,
  onHeartbeat?: (msg: string) => void
): Promise<NodeJS.ReadableStream & { closeAll?: () => void }> {
  const isSql = /\.sql$/i.test(path);
  const isSqlBz2 = /\.sql\.bz2$/i.test(path);
  const isTar = /\.(tar\.bz2|tbz2?)$/i.test(path);
  if (!isSql && !isSqlBz2 && !isTar)
    throw new Error("expected a .sql, .sql.bz2 or .tar.bz2 dump file");
  // dynamic imports BEFORE creating the stream: the heartbeat data listener
  // switches the source to flowing mode, so everything downstream must be
  // piped in the same tick or the first chunks are lost
  const bz2 = isSql ? null : (await import("unbzip2-stream")).default;
  const tar = isTar ? await import("tar-stream") : null;

  const total = fs.statSync(path).size;
  const mb = (n: number) => Math.round(n / 1048576);
  let read = 0;
  let lastBeat = 0;
  const src = fs.createReadStream(path);
  src.on("data", (c: string | Buffer) => {
    read += typeof c === "string" ? c.length : c.byteLength;
    const now = Date.now();
    if (now - lastBeat > 4000) {
      lastBeat = now;
      onHeartbeat?.(
        `reading dump: ${mb(read)}/${mb(total)} MB (${Math.round((read / total) * 100)}%)`
      );
    }
  });
  // the data listener switched src to flowing: pause until a consumer
  // (pipe/iteration) attaches, so no chunk is emitted into the void
  src.pause();
  // closeAll: the caller MUST call it when it stops consuming — an aborted
  // scan (bad file, parse error) used to leak the fd and the decompression
  // pipeline for the process lifetime, once per failed attempt.
  const withClose = <T extends NodeJS.ReadableStream>(
    stream: T,
    ...others: { destroy: (e?: Error) => void }[]
  ): T & { closeAll: () => void } =>
    Object.assign(stream, {
      closeAll: () => {
        for (const o of [src, ...others]) {
          try {
            o.destroy();
          } catch {
            /* already closed */
          }
        }
      },
    });
  if (isSql) return withClose(src);
  if (isSqlBz2) {
    const un = bz2!();
    return withClose(src.pipe(un) as NodeJS.ReadableStream, un);
  }
  {
    const extract = tar!.extract();
    const unzip = bz2!();
    src.pipe(unzip).pipe(extract);
    // Event API on purpose: leaving a for-await loop destroys the extractor
    // and with it the entry stream we still need to read (STREAM_DESTROYED).
    // next() is only called for skipped entries: tar parsing then pauses on
    // the matched one, which keeps flowing as we consume it.
    return await new Promise<NodeJS.ReadableStream & { closeAll: () => void }>((resolve, reject) => {
      extract.on(
        "entry",
        (
          header: { name: string },
          stream: NodeJS.ReadableStream & {
            resume: () => void;
            destroy: (e?: Error) => void;
          },
          next: () => void
        ) => {
          if (/osu_beatmaps\.sql$/.test(header.name)) {
            // A failure upstream (truncated archive, bzip2 error) reaches nobody
            // once this promise has resolved: the entry would simply never end
            // and the read would hang for ever — with the sync bar stuck on
            // "dump verification". Forward it onto the stream we hand back.
            const fail = (e: Error) => stream.destroy(e);
            src.on("error", fail);
            unzip.on("error", fail);
            extract.on("error", fail);
            resolve(withClose(stream, unzip, extract));
          } else {
            stream.resume(); // skip (the scores tables are the bulk)
            next();
          }
        }
      );
      extract.on("error", reject);
      extract.on("finish", () =>
        reject(new Error("osu_beatmaps.sql not found in the archive"))
      );
    });
  }
}

let dumpVerifyRunning = false;

/** null = already running. Returns the per-mode pool growth (see poolGrowth). */
export async function verifyCatalogFromDump(
  path: string,
  modes: number[],
  onProgress?: (msg: string) => void,
  onHeartbeat: (msg: string) => void = () => {}
): Promise<{ total: number; label: string } | null> {
  if (dumpVerifyRunning) return null;
  dumpVerifyRunning = true;
  try {
    const db = getDb();
    const local = new Set<number>(
      (db.prepare("SELECT id FROM beatmaps").all() as { id: number }[]).map(
        (r) => r.id
      )
    );
    const wanted = new Set(modes);
    // beatmap_id -> its mode + set, so the leftovers can be named at the end
    const missing = new Map<number, { mode: number; setId: number }>();
    const sets = new Set<number>();
    let scanned = 0;
    let deleted = 0;
    onProgress?.("scanning the dump…");
    const stream = await openDump(path, onHeartbeat);
    try {
      for await (const d of parseOsuBeatmapsSql(stream)) {
        scanned++;
        if (scanned % 200_000 === 0)
          onHeartbeat(`dump scan: ${scanned} diffs read…`);
        // deleted from osu! but still marked ranked: no lookup can ever bring it
        // back, counting it as a hole made every run report the same phantoms
        if (d.deleted) {
          deleted++;
          continue;
        }
        if (![1, 2, 4].includes(d.approved)) continue;
        if (!wanted.has(d.playmode)) continue;
        if (local.has(d.beatmapId)) continue;
        missing.set(d.beatmapId, { mode: d.playmode, setId: d.setId });
        sets.add(d.setId);
      }
    } finally {
      // an aborted scan (parse error, bad file) must not leak the fd and the
      // bzip2/tar pipeline — the user typically retries with another file
      stream.closeAll?.();
    }
    // 0 rows = nothing was read (wrong file, empty archive): saying "complete"
    // here would be the exact opposite of the truth
    if (scanned === 0)
      throw new Error(
        "no beatmap row in this file. Expected a .tar.bz2 from data.ppy.sh, " +
          "or the osu_beatmaps.sql it contains."
      );
    const perMode = new Map<number, number>();
    for (const { mode } of missing.values())
      perMode.set(mode, (perMode.get(mode) ?? 0) + 1);
    onProgress?.(
      `dump read: ${scanned} rows, ${deleted} deleted maps ignored, ` +
        `${local.size} diffs already here. Missing ` +
        (missing.size === 0
          ? `nothing for ${modes.map((m) => rulesetDef(m).name).join(", ")}, catalog complete`
          : [...perMode.entries()]
              .map(([m, n]) => `${rulesetDef(m).name} ${n} diffs`)
              .join(", ") + `, in ${sets.size} sets to fetch`)
    );

    // import the missing sets by direct lookup (answers for DMCA'd sets).
    // Compared modes can include a std catalog kept only as a convert source;
    // user rows exist for the STARTED modes only.
    const seedModes = getStartedRulesets();
    const seedStmt = db.prepare(
      `INSERT OR IGNORE INTO beatmap_user (beatmap_id, ruleset)
       SELECT id, ? FROM beatmaps
       WHERE beatmapset_id = ? AND (ruleset = ? OR ruleset = 0)`
    );
    const before = poolCounts();
    let done = 0;
    let failed = 0;
    let noSource = 0;
    for (const id of sets) {
      try {
        const r = await importOneSet(id);
        if (r.source === null) noSource++; // neither the API nor the web page
        if (r.newIds.length)
          for (const m of seedModes) seedStmt.run(m, id, m);
      } catch (e) {
        failed++;
        console.error(`[dump] set ${id}:`, e instanceof Error ? e.message : e);
      }
      done++;
      if (done % 25 === 0)
        onProgress?.(
          `dump import: ${done}/${sets.size} sets (${poolGrowth(before, poolCounts()).label})`
        );
    }
    const g = poolGrowth(before, poolCounts());
    onProgress?.(
      `dump import done: ${done} sets, ${g.label}` +
        (noSource ? `, ${noSource} sets the API does not serve` : "") +
        (failed ? `, ${failed} errors` : "")
    );

    // What the run could NOT recover — the honest answer to "why are N maps
    // still missing?". Deleted diffs are filtered out of the scan already, so
    // what is left here is a set no channel serves any more.
    const known = db.prepare("SELECT 1 FROM beatmaps WHERE id = ?");
    const leftPerMode = new Map<number, number>();
    const leftSets = new Set<number>();
    for (const [id, m] of missing) {
      if (known.get(id)) continue;
      leftPerMode.set(m.mode, (leftPerMode.get(m.mode) ?? 0) + 1);
      leftSets.add(m.setId);
    }
    if (leftSets.size > 0)
      onProgress?.(
        `still missing: ` +
          [...leftPerMode.entries()]
            .map(([m, n]) => `${rulesetDef(m).name} ${n} diffs`)
            .join(", ") +
          ` in ${leftSets.size} set(s) nothing can serve (ids: ${[...leftSets]
            .slice(0, 10)
            .join(", ")})`
      );
    return g;
  } finally {
    dumpVerifyRunning = false;
  }
}
