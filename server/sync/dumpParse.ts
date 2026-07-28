/**
 * Parser for the `osu_beatmaps.sql` mysqldump of a data.ppy.sh dump. Kept apart
 * from dump.ts so it can be unit-tested without opening a database.
 */

export interface DumpDiff {
  beatmapId: number;
  setId: number;
  playmode: number;
  approved: number;
  /** soft-deleted row (deleted_at set): still carries its old `approved` */
  deleted: boolean;
}

/**
 * Walks the `(...),(...)` tuples of one INSERT line ('' strings, \' escapes).
 * String CONTENTS are dropped on purpose (we only read numeric columns): a
 * quoted field therefore yields "", while a literal NULL yields "NULL" — that
 * difference is what tells a soft-deleted row from a live one.
 */
export function* scanTuples(line: string): Generator<string[]> {
  let i = line.indexOf("(");
  if (i === -1) return;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let field = "";
  let fields: string[] = [];
  for (; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "'") inString = false;
      continue;
    }
    if (c === "'") inString = true;
    else if (c === "(" && depth === 0) {
      depth = 1;
      field = "";
      fields = [];
    } else if (c === "," && depth === 1) {
      fields.push(field);
      field = "";
    } else if (c === ")" && depth === 1) {
      fields.push(field);
      depth = 0;
      yield fields;
    } else if (depth === 1) field += c;
  }
}

/**
 * Streaming parser: reads the CREATE TABLE to locate the columns, then scans
 * every INSERT statement (mysqldump writes one statement per line; bytes are
 * decoded as latin1 so multi-byte text in string fields cannot corrupt the
 * numeric fields we read).
 *
 * Soft-deleted diffs are FLAGGED, not dropped, so the caller can report how
 * many it ignored: `osu_beatmaps` uses SoftDeletes (osu-web Beatmap model) and
 * keeps the last `approved` value, so a deleted-from-osu! map still reads as
 * ranked in the dump and used to come back "missing" on every run.
 * Throws when the file carries no `osu_beatmaps` table at all — silently
 * yielding nothing reads as "catalog complete", which is the opposite.
 */
export async function* parseOsuBeatmapsSql(
  stream: NodeJS.ReadableStream
): AsyncGenerator<DumpDiff> {
  let idx: Record<string, number> | null = null;
  const seen: Record<string, number> = {};
  let column = 0;
  let inCreate = false;
  let checked = 0;
  let buf = "";
  for await (const chunk of stream) {
    buf += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf("\n", start)) !== -1) {
      const line = buf.slice(start, nl);
      start = nl + 1;
      if (!idx) {
        if (line.startsWith("CREATE TABLE `osu_beatmaps`")) inCreate = true;
        else if (inCreate) {
          // camelCase matters: countTotal/countNormal/countSlider/countSpinner
          // are real columns, and missing them shifted every later column by 4
          // (playmode read diff_drain, approved read diff_size). Index counted
          // explicitly so a repeated name cannot shift the rest either.
          const m = /^\s*`([A-Za-z0-9_]+)`/.exec(line);
          if (m) seen[m[1]] = column++;
          else if (line.startsWith(")")) {
            inCreate = false;
            for (const n of ["beatmap_id", "beatmapset_id", "playmode", "approved"])
              if (!(n in seen))
                throw new Error(`osu_beatmaps.sql: missing column ${n}`);
            idx = seen;
          }
        }
        continue;
      }
      if (!line.startsWith("INSERT INTO `osu_beatmaps`")) continue;
      for (const f of scanTuples(line)) {
        const d: DumpDiff = {
          beatmapId: Number(f[idx.beatmap_id]),
          setId: Number(f[idx.beatmapset_id]),
          playmode: Number(f[idx.playmode]),
          approved: Number(f[idx.approved]),
          // absent column (older dump) = nothing was ever deleted. A quoted
          // timestamp reads as "" here (scanTuples drops string contents), a
          // literal NULL reads as "NULL".
          deleted:
            idx.deleted_at != null &&
            (f[idx.deleted_at] ?? "NULL").trim() !== "NULL",
        };
        if (!Number.isFinite(d.beatmapId) || !Number.isFinite(d.setId)) continue;
        // Alignment guard on the first rows: a shifted column silently turns
        // the whole comparison into noise (that is exactly what happened), and
        // mode/status have narrow legal ranges, so a misread shows up at once.
        if (checked++ < 1000 && (d.playmode < 0 || d.playmode > 3 || d.approved < -2 || d.approved > 4))
          throw new Error(
            `osu_beatmaps.sql: column alignment looks wrong ` +
              `(beatmap ${d.beatmapId}: playmode=${d.playmode}, approved=${d.approved})`
          );
        yield d;
      }
    }
    buf = buf.slice(start);
  }
  if (!idx)
    throw new Error(
      "no `osu_beatmaps` table in this file. Expected the osu_beatmaps.sql " +
        "of a data.ppy.sh archive."
    );
}
