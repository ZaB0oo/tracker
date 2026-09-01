import { config } from "../config.js";
import { getDb, getState, setState } from "../db/db.js";
import { getStoredCountryCode, getStoredProfile } from "../osu/api.js";
import { localPp, localStarRating, perfHits } from "../osu/difficulty.js";
import { evalMetric } from "../logic/metricEval.js";
import type { MetricParams } from "../logic/metrics.js";
import { srMods, srModsKey, type ModRef } from "../logic/score.js";

const logError = (e: unknown, ctx: string) =>
  console.error(`[${ctx}] ${e instanceof Error ? e.message : String(e)}`);

/**
 * Discord notifications via a channel webhook (no bot). The webhook URL and
 * per-event toggles live in the settings DB (never in the repo).
 *
 * Anti-spam by construction: best-score events are only emitted by the
 * POLLING ingestion path (the backfill never notifies), batched per poll tick
 * (up to 5 embeds/message). Sending is fire-and-forget: a Discord outage
 * never blocks the sync.
 */

const WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export interface DiscordSettings {
  webhookSet: boolean;
  /** the configured webhooks, URL masked for display (token hidden). The
   * per-webhook flags are the ONLY routing truth: the historical global
   * bests/metrics switches were folded into them (see the migration). */
  webhooks: { url: string; name: string; bests: boolean; metrics: boolean }[];
  template: DiscordTemplate;
}

/** the best-notification layout, editable in the settings */
export interface DiscordTemplate {
  /** embed title (placeholders allowed) */
  title: string;
  /** embed description, one template line per embed line */
  body: string;
  cover: boolean;
  footer: boolean;
  author: boolean;
}

/** the built-in layout — exactly the historical rendering */
export const DEFAULT_TEMPLATE: DiscordTemplate = {
  title: "{new} {artist} - {title} [{diff}] {srb}",
  body: [
    "**{grade}** {mods} · **{score}** · {acc} {fc} · {when}",
    "**{combo}**{maxcombo} · {hits} · **{pp}**",
    "{mapstats}",
    "{honors}",
  ].join("\n"),
  cover: true,
  footer: true,
  author: true,
};

function getDiscordTemplate(): DiscordTemplate {
  try {
    const raw = getState("discord_template");
    if (!raw) return DEFAULT_TEMPLATE;
    const t = JSON.parse(raw) as Partial<DiscordTemplate>;
    return {
      title:
        typeof t.title === "string" && t.title.trim() !== ""
          ? t.title
          : DEFAULT_TEMPLATE.title,
      body:
        typeof t.body === "string" && t.body.trim() !== ""
          ? t.body
          : DEFAULT_TEMPLATE.body,
      cover: t.cover !== false,
      footer: t.footer !== false,
      author: t.author !== false,
    };
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

/**
 * The configured webhooks (url + display name). Stored as a JSON array of
 * objects; plain strings from the first multi-webhook version and the
 * historical single-URL key are both read as fallbacks so existing setups
 * keep working, and everything is rewritten in the new shape on first write.
 */
export interface WebhookEntry {
  url: string;
  /** display name so several servers stay tellable apart ("" = unnamed) */
  name: string;
  /** this webhook receives best-score notifications */
  bests: boolean;
  /** this webhook receives metric milestone / progress posts */
  metrics: boolean;
}

/**
 * One-shot: the pre-1.28.1 GLOBAL bests/metrics switches duplicated the
 * per-webhook columns (a webhook could show "Bests ✓" while the hidden
 * global gate silently dropped everything). A global switch that was OFF is
 * folded into every entry's flag, then both keys are retired: the table
 * columns are the single source of truth from here on.
 */
let globalsMigrated = false;
function migrateGlobalToggles(): void {
  if (globalsMigrated) return;
  globalsMigrated = true;
  const offBests = getState("discord_notify_bests") === "0";
  const offMetrics = getState("discord_notify_metrics") === "0";
  if (offBests || offMetrics) {
    const list = getWebhookEntries().map((e) => ({
      ...e,
      bests: offBests ? false : e.bests,
      metrics: offMetrics ? false : e.metrics,
    }));
    writeWebhookEntries(list);
  }
  setState("discord_notify_bests", "");
  setState("discord_notify_metrics", "");
}

export function getWebhookEntries(): WebhookEntry[] {
  const raw = getState("discord_webhook_urls");
  if (raw) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr))
        return arr
          .map((e): WebhookEntry | null => {
            if (typeof e === "string")
              return e ? { url: e, name: "", bests: true, metrics: true } : null;
            if (e && typeof e === "object" && typeof (e as { url?: unknown }).url === "string") {
              const o = e as { url: string; name?: unknown; bests?: unknown; metrics?: unknown };
              return {
                url: o.url,
                name: String(o.name ?? "").slice(0, 60),
                bests: o.bests !== false,
                metrics: o.metrics !== false,
              };
            }
            return null;
          })
          .filter((e): e is WebhookEntry => e != null && e.url !== "");
    } catch {
      /* fall through to the legacy key */
    }
  }
  const legacy = getState("discord_webhook_url");
  return legacy ? [{ url: legacy, name: "", bests: true, metrics: true }] : [];
}

export function getWebhookUrls(): string[] {
  return getWebhookEntries().map((e) => e.url);
}

const MAX_WEBHOOKS = 5;

/** does at least one webhook receive this message kind? */
function hasKindTarget(kind: "best" | "metric"): boolean {
  return getWebhookEntries().some((e) => (kind === "best" ? e.bests : e.metrics));
}

function writeWebhookEntries(list: WebhookEntry[]): void {
  setState("discord_webhook_urls", JSON.stringify(list.slice(0, MAX_WEBHOOKS)));
  setState("discord_webhook_url", ""); // the legacy key is retired
}

/** URL shown in the settings list: webhook id kept, token hidden */
const maskWebhook = (u: string): string =>
  u.replace(/(\/api\/webhooks\/\d+\/).+$/, (_m, p: string) => `${p}····${u.slice(-4)}`);

export function getDiscordSettings(): DiscordSettings {
  migrateGlobalToggles();
  const entries = getWebhookEntries();
  return {
    webhookSet: entries.length > 0,
    webhooks: entries.map((e) => ({
      url: maskWebhook(e.url),
      name: e.name,
      bests: e.bests,
      metrics: e.metrics,
    })),
    template: getDiscordTemplate(),
  };
}

export function setDiscordSettings(o: {
  webhookUrl?: string | null; // legacy single-URL field: "" clears the list, a URL replaces it
  /** append one webhook to the list (deduplicated, capped) */
  webhookAdd?: string;
  /** display name for the webhook being added */
  webhookAddName?: string;
  /** remove the webhook at this index of the stored list */
  webhookRemoveAt?: number;
  /** edit the webhook at this index (partial: only given fields change) */
  webhookUpdateAt?: number;
  webhookUpdate?: { name?: string; url?: string; bests?: boolean; metrics?: boolean };
  /** null resets to the default layout */
  template?: {
    title?: unknown;
    body?: unknown;
    cover?: unknown;
    footer?: unknown;
    author?: unknown;
  } | null;
}): string | null {
  if (o.webhookUrl != null) {
    const url = o.webhookUrl.trim();
    if (url !== "" && !WEBHOOK_RE.test(url))
      return "invalid webhook URL (expected https://discord.com/api/webhooks/...)";
    writeWebhookEntries(url === "" ? [] : [{ url, name: "", bests: true, metrics: true }]);
  }
  if (o.webhookAdd != null) {
    const url = o.webhookAdd.trim();
    if (!WEBHOOK_RE.test(url))
      return "invalid webhook URL (expected https://discord.com/api/webhooks/...)";
    const list = getWebhookEntries();
    if (!list.some((e) => e.url === url)) {
      if (list.length >= MAX_WEBHOOKS) return `${MAX_WEBHOOKS} webhooks max`;
      list.push({
        url,
        name: String(o.webhookAddName ?? "").trim().slice(0, 60),
        bests: true,
        metrics: true,
      });
      writeWebhookEntries(list);
    }
  }
  if (o.webhookUpdateAt != null && o.webhookUpdate != null) {
    const list = getWebhookEntries();
    const i = Math.floor(o.webhookUpdateAt);
    if (!Number.isInteger(i) || i < 0 || i >= list.length)
      return "no webhook at this position";
    const u = o.webhookUpdate;
    if (u.url != null && u.url.trim() !== "") {
      const url = u.url.trim();
      if (!WEBHOOK_RE.test(url))
        return "invalid webhook URL (expected https://discord.com/api/webhooks/...)";
      if (list.some((e, j) => j !== i && e.url === url))
        return "this webhook is already in the list";
      list[i].url = url;
    }
    if (u.name != null) list[i].name = u.name.trim().slice(0, 60);
    if (u.bests != null) list[i].bests = u.bests;
    if (u.metrics != null) list[i].metrics = u.metrics;
    writeWebhookEntries(list);
  }
  if (o.webhookRemoveAt != null) {
    const list = getWebhookEntries();
    const i = Math.floor(o.webhookRemoveAt);
    // Number.isInteger also rejects NaN, which passes both < and >= guards
    // and would make splice silently delete the FIRST webhook
    if (!Number.isInteger(i) || i < 0 || i >= list.length)
      return "no webhook at this position";
    list.splice(i, 1);
    writeWebhookEntries(list);
  }
  if (o.template !== undefined) {
    if (o.template === null) setState("discord_template", "");
    else
      setState(
        "discord_template",
        JSON.stringify({
          title: String(o.template.title ?? "").slice(0, 256),
          body: String(o.template.body ?? "").slice(0, 1800),
          cover: o.template.cover !== false,
          footer: o.template.footer !== false,
          author: o.template.author !== false,
        })
      );
  }
  return null;
}

/**
 * Placeholder substitution with self-erasing segments: each template line is
 * split on «·», and a segment whose placeholders ALL resolved empty is
 * dropped (so a score without pp or mods leaves no dangling separator); a
 * line whose placeholders all resolved empty disappears entirely.
 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  // a bold wrapper around a value that is already bold (honors carry their
  // own **) would nest ** and print literal stars; around a timestamp it
  // breaks the <t:..> rendering. Drop the wrapper in both cases.
  tpl = tpl.replace(/\*\*\{(\w+)\}\*\*/g, (m, k: string) => {
    const v = vars[k] ?? "";
    return v === "" || v.includes("**") || v.startsWith("<t:") ? `{${k}}` : m;
  });
  return tpl
    .split("\n")
    .map((line) => {
      let lineHasPh = false;
      let lineHasVal = false;
      const segs = line
        .split("·")
        .map((seg) => {
          let segHasPh = false;
          let segHasVal = false;
          const out = seg.replace(/\{(\w+)\}/g, (_, k: string) => {
            segHasPh = true;
            lineHasPh = true;
            const v = vars[k] ?? "";
            if (v !== "") {
              segHasVal = true;
              lineHasVal = true;
            }
            return v;
          });
          if (segHasPh && !segHasVal) return null;
          return out.replace(/\s+/g, " ").trim();
        })
        .filter((x): x is string => x != null && x !== "");
      if (segs.length === 0) return null;
      if (lineHasPh && !lineHasVal) return null;
      return segs.join(" · ");
    })
    .filter((l): l is string => l != null)
    .join("\n");
}

// ---------------------------------------------------------------- sending

interface Embed {
  title?: string;
  description?: string;
  color: number;
  url?: string;
  author?: { name: string; icon_url?: string; url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  footer?: { text: string };
}

interface WebhookMessage {
  content?: string;
  embeds: Embed[];
  /** what this message is, so per-webhook filters can route it
   * (undefined: administrative, e.g. a test — goes everywhere) */
  kind?: "best" | "metric";
  /** best notifications: the event behind each embed (index-aligned), so a
   * deferred honors confirmation can edit the already-posted message */
  meta?: { events: BestEvent[]; author: Embed["author"] | undefined };
}

const queue: WebhookMessage[] = [];
let draining = false;

/** characters Discord counts toward its 6000-char combined embed cap */
const embedChars = (e: Embed) =>
  (e.title?.length ?? 0) +
  (e.description?.length ?? 0) +
  (e.footer?.text.length ?? 0) +
  (e.author?.name.length ?? 0);

/** stay under Discord's 6000 combined cap with margin for serialization */
const EMBED_BUDGET = 5800;

function enqueue(message: WebhookMessage): void {
  if (getWebhookUrls().length === 0) return;
  // Discord caps the COMBINED characters of one message's embeds at 6000
  // (each embed alone already fits: descriptions are cut at 4000). Five
  // long custom-template embeds can blow past it and the whole message
  // would bounce with a 400, so an oversized batch is split here, where
  // every sender goes through.
  if (message.embeds.length > 1) {
    const parts: WebhookMessage[] = [];
    let cur: Embed[] = [];
    let curEv: BestEvent[] = [];
    let chars = 0;
    const part = (): WebhookMessage =>
      message.meta
        ? { embeds: cur, kind: message.kind, meta: { events: curEv, author: message.meta.author } }
        : { embeds: cur, kind: message.kind };
    message.embeds.forEach((e, i) => {
      const c = embedChars(e);
      if (cur.length > 0 && chars + c > EMBED_BUDGET) {
        parts.push(part());
        cur = [];
        curEv = [];
        chars = 0;
      }
      cur.push(e);
      // the events stay index-aligned with the embeds through the split
      if (message.meta) curEv.push(message.meta.events[i]);
      chars += c;
    });
    parts.push(part());
    parts[0].content = message.content;
    queue.push(...parts);
  } else {
    queue.push(message);
  }
  if (!draining) void drain();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (queue.length > 0) {
      // re-read per message: the webhook list can change (or be cleared)
      // while a long batch drains, and the messages must follow the setting
      // rather than the list captured when the queue started
      const entries = getWebhookEntries();
      if (entries.length === 0) {
        queue.length = 0;
        break;
      }
      const message = queue[0];
      // per-webhook routing: each channel only gets the kinds it asked for
      const urls = entries
        .filter((e) =>
          message.kind === "best" ? e.bests : message.kind === "metric" ? e.metrics : true
        )
        .map((e) => e.url);
      // every configured webhook receives the same message; one failing
      // channel never blocks the others
      const targets: { url: string; messageId: string }[] = [];
      for (const url of urls) {
        let attempts = 0;
        for (;;) {
          attempts++;
          try {
            // best notifications ask Discord for the created message back
            // (?wait=true): its id is what lets a deferred honors
            // confirmation edit the embed later
            const postUrl = message.meta
              ? `${url}${url.includes("?") ? "&" : "?"}wait=true`
              : url;
            const res = await fetch(postUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: message.content,
                embeds: message.embeds,
              }),
            });
            if (res.status === 429) {
              // capped: a webhook permanently answering 429 must not hold
              // the whole queue hostage
              if (attempts >= 6) {
                logError("HTTP 429 (gave up)", "discord webhook");
                break;
              }
              const body = (await res.json().catch(() => null)) as
                | { retry_after?: number }
                | null;
              await sleep(Math.min((body?.retry_after ?? 2) * 1000, 30_000));
              continue;
            }
            if (!res.ok && attempts < 3) {
              await sleep(2000);
              continue;
            }
            if (!res.ok) logError(`HTTP ${res.status}`, "discord webhook");
            else if (message.meta) {
              const body = (await res.json().catch(() => null)) as
                | { id?: string }
                | null;
              if (body?.id) targets.push({ url, messageId: String(body.id) });
            }
            break;
          } catch (e) {
            if (attempts >= 3) {
              logError(e, "discord webhook");
              break;
            }
            await sleep(2000);
          }
        }
      }
      if (targets.length > 0) registerHonorWatch(targets, message);
      queue.shift();
    }
  } finally {
    draining = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- late honors edits
// The leaderboards can lag behind a fresh submit: the notification often goes
// out before the API sees the score on top, and only the deferred confirms
// (or the sweeps) discover the country #1 / global top afterwards. Each best
// message is therefore remembered here (webhook message id + its events);
// when a later check upgrades the honors of a watched map, the posted embed
// is rebuilt and PATCHed in place, so the message ends up telling the truth.

interface SentBestMessage {
  /** the same message as posted on each webhook (one id per channel) */
  targets: { url: string; messageId: string }[];
  embeds: Embed[];
}
const honorWatch = new Map<
  string, // `${ruleset}:${beatmapId}`
  {
    msg: SentBestMessage; // shared by the embeds of one message
    idx: number;
    event: BestEvent;
    author: Embed["author"] | undefined;
    at: number;
  }
>();
const HONOR_WATCH_TTL_MS = 24 * 3600_000;
const HONOR_WATCH_MAX = 300;

const hasAllHonors = (e: BestEvent): boolean =>
  e.countryFirst === true && e.globalRank != null && e.globalRank <= 100;

function pruneHonorWatch(): void {
  const now = Date.now();
  for (const [k, v] of honorWatch)
    if (now - v.at > HONOR_WATCH_TTL_MS) honorWatch.delete(k);
  while (honorWatch.size > HONOR_WATCH_MAX)
    honorWatch.delete(honorWatch.keys().next().value!);
}

function registerHonorWatch(
  targets: { url: string; messageId: string }[],
  message: WebhookMessage
): void {
  if (!message.meta) return;
  pruneHonorWatch();
  const msg: SentBestMessage = { targets, embeds: message.embeds };
  message.meta.events.forEach((event, idx) => {
    const key = `${event.ruleset}:${event.beatmapId}`;
    // a newer best supersedes any older watch on the map: honors discovered
    // from now on belong to THIS message, never to the superseded one
    honorWatch.delete(key);
    if (hasAllHonors(event)) return; // nothing more can arrive
    honorWatch.set(key, {
      msg,
      idx,
      event,
      author: message.meta!.author,
      at: Date.now(),
    });
  });
}

/**
 * Called by the daemon after every country/global state write: if the map's
 * best was recently notified WITHOUT one of the honors it now holds, rebuild
 * that embed and edit the webhook message. Cheap no-op for unwatched maps.
 */
export function updateBestHonors(beatmapId: number, ruleset: number): void {
  const key = `${ruleset}:${beatmapId}`;
  const w = honorWatch.get(key);
  if (!w) return;
  try {
    const row = getDb()
      .prepare(
        "SELECT global_rank, country_first FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ?"
      )
      .get(beatmapId, ruleset) as
      | { global_rank: number | null; country_first: number }
      | undefined;
    if (!row) return;
    const gainedCountry = row.country_first === 1 && w.event.countryFirst !== true;
    const gainedGlobal =
      row.global_rank != null &&
      row.global_rank <= 100 &&
      !(w.event.globalRank != null && w.event.globalRank <= 100);
    if (!gainedCountry && !gainedGlobal) return;
    if (gainedCountry) w.event.countryFirst = true;
    if (gainedGlobal) w.event.globalRank = row.global_rank;
    w.msg.embeds[w.idx] = bestEmbed(w.event, w.author);
    if (hasAllHonors(w.event)) honorWatch.delete(key);
    void editWebhookMessage(w.msg);
  } catch (e) {
    logError(e, "discord honors edit");
  }
}

async function editWebhookMessage(msg: SentBestMessage): Promise<void> {
  for (const t of msg.targets) {
    for (let attempts = 1; ; attempts++) {
      try {
        const res = await fetch(`${t.url}/messages/${t.messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: msg.embeds }),
        });
        if (res.status === 429) {
          if (attempts >= 6) {
            logError("HTTP 429 (gave up)", "discord honors edit");
            break;
          }
          const body = (await res.json().catch(() => null)) as
            | { retry_after?: number }
            | null;
          await sleep(Math.min((body?.retry_after ?? 2) * 1000, 30_000));
          continue;
        }
        if (!res.ok) logError(`HTTP ${res.status}`, "discord honors edit");
        break;
      } catch (e) {
        if (attempts >= 3) {
          logError(e, "discord honors edit");
          break;
        }
        await sleep(2000);
      }
    }
  }
}

// ---------------------------------------------------------------- helpers

const PINK = 0xff66aa;

interface MapRow {
  artist: string;
  title: string;
  version: string;
  star_rating: number | null;
  beatmapset_id: number;
  creator: string;
  ranked_date: string | null;
  status: number;
  bpm: number | null;
  cs: number | null;
  ar: number | null;
  od: number | null;
  hp: number | null;
  total_length: number | null;
  max_combo: number | null;
}

function mapRow(beatmapId: number): MapRow | undefined {
  return getDb()
    .prepare(
      `SELECT st.artist, st.title, b.version, b.star_rating, b.beatmapset_id,
              st.creator, st.ranked_date, b.status, b.bpm, b.cs, b.ar, b.od, b.hp,
              b.total_length, b.max_combo
       FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
       WHERE b.id = ?`
    )
    .get(beatmapId) as MapRow | undefined;
}

const mapUrl = (beatmapId: number) => `https://osu.ppy.sh/beatmaps/${beatmapId}`;
const coverUrl = (setId: number) =>
  `https://assets.ppy.sh/beatmaps/${setId}/covers/cover.jpg`;

const displayGrade = (g: string) => (g === "XH" ? "SSH" : g === "X" ? "SS" : g);

/** author line from the connected profile (best effort, no API call). */
function profileAuthor(): Embed["author"] | undefined {
  try {
    const p = getStoredProfile();
    if (!p?.username) return undefined;
    const bits = [p.username];
    if (p.stats?.pp) bits.push(`${Math.round(p.stats.pp).toLocaleString("en-US")}pp`);
    const ranks = [
      p.stats?.global_rank != null ? `#${p.stats.global_rank.toLocaleString("en-US")}` : "",
      p.stats?.country_rank != null ? `${p.country_code ?? ""}${p.stats.country_rank}` : "",
    ].filter(Boolean);
    if (ranks.length) bits.push(`(${ranks.join(" ")})`);
    return {
      name: bits.join(" · "),
      icon_url: p.avatar_url || undefined,
      url: `https://osu.ppy.sh/users/${config.osuUserId}`,
    };
  } catch {
    return undefined;
  }
}

interface ParsedMods {
  label: string; // "+HDDT (1.5x)" or ""
  rate: number;
  hr: boolean;
  ez: boolean;
}

/** lazer mods JSON ([{acronym, settings?}]) → display label + difficulty factors. */
function parseMods(json: string): ParsedMods {
  let rate = 1;
  let hr = false;
  let ez = false;
  const acronyms: string[] = [];
  try {
    const arr = JSON.parse(json) as {
      acronym?: string;
      settings?: { speed_change?: number };
    }[];
    for (const m of arr) {
      const a = m.acronym ?? "";
      if (!a || a === "CL") continue; // classic marker on stable scores: noise
      acronyms.push(a);
      if (a === "DT" || a === "NC") rate = m.settings?.speed_change ?? 1.5;
      if (a === "HT" || a === "DC") rate = m.settings?.speed_change ?? 0.75;
      if (a === "HR") hr = true;
      if (a === "EZ") ez = true;
    }
  } catch {
    // ignore, nomod display
  }
  const rateTxt = rate !== 1 ? ` (${+rate.toFixed(2)}x)` : "";
  return {
    label: acronyms.length > 0 ? `+${acronyms.join("")}${rateTxt}` : "",
    rate,
    hr,
    ez,
  };
}

const clamp10 = (v: number) => Math.min(Math.max(v, 0), 10);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** each map stat adjusted for HR/EZ and the play rate, formatted ("" = unknown) */
function adjustedParts(m: MapRow, mods: ParsedMods) {
  const mul = mods.hr ? 1.4 : mods.ez ? 0.5 : 1;
  const csMul = mods.hr ? 1.3 : mods.ez ? 0.5 : 1;
  const p = { len: "", bpm: "", cs: "", ar: "", od: "", hp: "" };

  if (m.total_length != null && m.total_length > 0) {
    const len = Math.round(m.total_length / mods.rate);
    p.len = `${Math.floor(len / 60)}:${String(len % 60).padStart(2, "0")}`;
  }
  if (m.bpm != null && m.bpm > 0) p.bpm = `${round1(m.bpm * mods.rate)} BPM`;
  if (m.cs != null) p.cs = `CS ${Math.min(m.cs * csMul, 10).toFixed(2)}`;
  if (m.ar != null) {
    // AR -> preempt ms, apply rate, back to AR (can exceed 10 with DT)
    const base = clamp10(m.ar * mul);
    const ms = base < 5 ? 1200 + 600 * ((5 - base) / 5) : 1200 - 750 * ((base - 5) / 5);
    const adj = ms / mods.rate;
    const ar = adj > 1200 ? 5 - (adj - 1200) / 120 : 5 + (1200 - adj) / 150;
    p.ar = `AR ${ar.toFixed(2)}`;
  }
  if (m.od != null) {
    // OD -> hit window ms (300), apply rate, back to OD
    const base = clamp10(m.od * mul);
    const ms = (80 - 6 * base) / mods.rate;
    p.od = `OD ${((80 - ms) / 6).toFixed(2)}`;
  }
  if (m.hp != null) p.hp = `HP ${clamp10(m.hp * mul).toFixed(2)}`;
  return p;
}

/** CS/AR/OD/HP · BPM · length, adjusted for HR/EZ and the play rate. */
function adjustedStats(m: MapRow, mods: ParsedMods): string {
  const p = adjustedParts(m, mods);
  return [p.len, p.bpm, p.cs, p.ar, p.od, p.hp].filter(Boolean).join(" · ");
}

/** lazer statistics JSON → individual hit counts */
function hitStats(
  json: string
): { great: number; ok: number; meh: number; miss: number } | null {
  try {
    const s = JSON.parse(json) as {
      great?: number;
      ok?: number;
      meh?: number;
      miss?: number;
    };
    return {
      great: s.great ?? 0,
      ok: s.ok ?? 0,
      meh: s.meh ?? 0,
      miss: s.miss ?? 0,
    };
  } catch {
    return null;
  }
}

/** lazer statistics JSON → "{300/100/50/miss}" */
function hitCounts(json: string): string | null {
  const s = hitStats(json);
  return s ? `{${s.great}/${s.ok}/${s.meh}/${s.miss}}` : null;
}

// ---------------------------------------------------------------- events

export interface BestEvent {
  beatmapId: number;
  ruleset: number;
  firstClear: boolean;
  grade: string;
  accuracy: number; // 0..1
  fcState: number; // 0 PFC, 1 FC, 2+ non-FC
  score: number;
  /** lazer standardised score (total_score), {score} being classic */
  scoreStd?: number | null;
  combo: number;
  pp: number | null;
  /** locally estimated pp when the API left pp NULL (filled at notify time) */
  ppLocal?: number | null;
  endedAt: string; // ISO date of the play
  modsJson: string; // raw score mods JSON
  statisticsJson: string; // raw score statistics JSON
  /** SR with the play's mods (API attributes), null -> fall back to nomod SR */
  moddedSr: number | null;
  /** my global leaderboard position on the map, shown when <= 100 */
  globalRank: number | null;
  /** the score was country #1 at submit time (no snipe tracking here) */
  countryFirst?: boolean;
  /** previous country #1 holder displaced by this score */
  snipedUsername?: string | null;
}

/** everything a template can print about one best (formatted, "" = absent) */
/** "#1 FR" when the connected account's country is known */
function countryFirstLabel(): string {
  const cc = getStoredCountryCode();
  return cc ? `#1 ${cc}` : "country #1";
}

function templateVars(e: BestEvent, m: MapRow | undefined): Record<string, string> {
  const mods = parseMods(e.modsJson);
  const sr = e.moddedSr ?? m?.star_rating ?? null;
  const when = Math.floor(Date.parse(e.endedAt) / 1000);
  const stats = m ? adjustedParts(m, mods) : null;
  const hs = hitStats(e.statisticsJson);
  const vars: Record<string, string> = {
    new: e.firstClear ? "🆕" : "📈",
    artist: m?.artist ?? "",
    title: m?.title ?? `beatmap ${e.beatmapId}`,
    diff: m?.version ?? "",
    mapper: m?.creator ?? "",
    sr: sr != null ? `${sr.toFixed(2)}★` : "",
    srb: sr != null ? `[${sr.toFixed(2)}★]` : "",
    grade: displayGrade(e.grade),
    mods: mods.label,
    rate: mods.rate !== 1 ? `${+mods.rate.toFixed(2)}x` : "",
    score: e.score.toLocaleString("en-US"),
    scorestd: e.scoreStd != null ? e.scoreStd.toLocaleString("en-US") : "",
    acc: `${(e.accuracy * 100).toFixed(2)}%`,
    fc: e.fcState === 0 ? "PFC" : e.fcState === 1 ? "FC" : "",
    when: Number.isFinite(when) ? `<t:${when}:R>` : "",
    date: e.endedAt.slice(0, 10),
    combo: `${e.combo}x`,
    maxcombo:
      m?.max_combo != null && m.max_combo > 0 ? `/${m.max_combo}x` : "",
    hits: hitCounts(e.statisticsJson) ?? "",
    h300: hs ? String(hs.great) : "",
    h100: hs ? String(hs.ok) : "",
    h50: hs ? String(hs.meh) : "",
    hmiss: hs ? String(hs.miss) : "",
    pp:
      e.pp != null
        ? `${e.pp.toFixed(2)}pp`
        : e.ppLocal != null
          ? `~${e.ppLocal.toFixed(2)}pp`
          : "",
    bpm: stats?.bpm ?? "",
    len: stats?.len ?? "",
    cs: stats?.cs ?? "",
    ar: stats?.ar ?? "",
    od: stats?.od ?? "",
    hp: stats?.hp ?? "",
    mapstats: m ? adjustedStats(m, mods) : "",
    globaltop:
      e.globalRank != null && e.globalRank <= 100
        ? `🌍 **Global Top #${e.globalRank}**`
        : "",
    // "#1 FR" with the connected account's country code (same label as the
    // tables), generic "country #1" when no profile is stored yet
    country1: e.countryFirst
      ? `🥇 **${countryFirstLabel()}**${e.snipedUsername ? ` (sniped **${e.snipedUsername}**)` : ""}`
      : "",
  };
  vars.honors = [vars.globaltop, vars.country1].filter(Boolean).join(" · ");
  return vars;
}

function bestEmbed(e: BestEvent, author: Embed["author"] | undefined): Embed {
  const m = mapRow(e.beatmapId);
  const t = getDiscordTemplate();
  const vars = templateVars(e, m);
  const embed: Embed = {
    title: renderTemplate(t.title, vars).slice(0, 256),
    url: mapUrl(e.beatmapId),
    description: renderTemplate(t.body, vars).slice(0, 4000),
    color: PINK,
    ...(t.author ? { author } : {}),
  };
  if (m && t.cover) embed.image = { url: coverUrl(m.beatmapset_id) };
  if (m && t.footer) {
    const ranked = m.ranked_date ? ` • Ranked ${m.ranked_date.slice(0, 10)}` : "";
    embed.footer = { text: `Mapset by ${m.creator}${ranked}` };
  }
  return embed;
}

/** automation mods never earn pp, estimated or not */
const AUTOMATION = new Set(["RX", "AP", "AT", "CN"]);

/**
 * Local pp for a best the API left at NULL (unranked mod combo) — display
 * only. A missing .osu file is downloaded (one map per score, serialized,
 * and it lands in the shared cache for the backfill); rosu then computes in
 * a few tens of ms. Anything unavailable just omits the figure.
 */
async function tryLocalPp(e: BestEvent): Promise<number | null> {
  try {
    const m = mapRow(e.beatmapId);
    if (!m || (m.status !== 1 && m.status !== 2)) return null;
    let mods: ModRef[] = [];
    try {
      mods = (JSON.parse(e.modsJson) as ModRef[]) ?? [];
    } catch {
      // unreadable mods: treated as nomod
    }
    if (mods.some((x) => AUTOMATION.has(x?.acronym))) return null;
    if (perfHits(e.ruleset, e.statisticsJson) == null) return null;
    return await localPp(e.beatmapId, mods, e.ruleset, {
      statistics: e.statisticsJson,
      accuracy: e.accuracy,
      maxCombo: e.combo,
    });
  } catch {
    return null;
  }
}

/**
 * The star rating OF THE MODS PLAYED when the event arrived without one —
 * showing the nomod rating on a DT play reads plain wrong. Downloads the
 * map file if needed (like the pp estimate) and feeds the shared modded-SR
 * cache, so the table and records benefit from the computation too.
 */
async function tryLocalSr(e: BestEvent): Promise<number | null> {
  try {
    const played = srMods(e.modsJson);
    if (played.length === 0) return null; // nomod: the map rating IS right
    const sr = await localStarRating(e.beatmapId, played, e.ruleset);
    if (sr != null)
      getDb()
        .prepare(
          "INSERT OR REPLACE INTO modded_sr (beatmap_id, ruleset, mods, star_rating) VALUES (?, ?, ?, ?)"
        )
        .run(e.beatmapId, e.ruleset, srModsKey(played), sr);
    return sr;
  } catch {
    return null;
  }
}

/** the missing figures a notification can compute for free (cached files) */
async function fillComputed(e: BestEvent): Promise<void> {
  if (e.pp == null) e.ppLocal = await tryLocalPp(e);
  if (e.moddedSr == null) e.moddedSr = await tryLocalSr(e);
}

/**
 * Metric milestone notifications: after a poll tick that brought new scores,
 * every stored metric is re-evaluated (cached by scores version, so this is
 * one aggregate query per metric); crossing a step boundary posts one embed.
 * Countdown metrics notify on the way DOWN. The last notified boundary lives
 * in the state table, seeded silently on the first pass so enabling the
 * option never replays history; regressions (a score wipe) just move the
 * baseline without posting.
 *
 * Anti-spam: a metric with a tiny step (one point of ranked score...) would
 * otherwise post on every poll tick, so each metric notifies at most once
 * per cooldown window. Crossings inside the window are absorbed (the floor
 * still advances); the next notification simply shows the newest boundary.
 */
const MILESTONE_COOLDOWN_MS = 30 * 60_000;

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * Text gauge rendered inside an inline code span: smooth 1/8-block precision,
 * the empty track is the code background itself. `█████████▎        `
 */
const PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const bar = (pct: number, w: number): string => {
  const units = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w * 8);
  const full = Math.floor(units / 8);
  const part = PARTIAL[units - full * 8];
  return `${"█".repeat(full)}${part}${" ".repeat(Math.max(0, w - full - (part ? 1 : 0)))}`;
};
const gauge = (pct: number, w = 34): string => `\`${bar(pct, w)}\``;

const BREAKDOWN_HEAD: Record<string, string> = {
  sr: "By star rating",
  year: "By year",
  length: "By length",
  combo: "By max combo",
  ar: "By AR",
  od: "By OD",
  cs: "By CS",
  hp: "By HP",
};

/** same bucket labels as the metric card */
function bucketLabel(dim: string, bucket: number | string): string {
  const n = Number(bucket);
  switch (dim) {
    case "sr":
      return n >= 10 ? "10★+" : `${n}–${n + 1}★`;
    case "year":
      return String(bucket);
    case "length":
      return n >= 10 ? "10 min+" : `${n}–${n + 1} min`;
    case "combo":
      return n >= 10 ? "2500+" : `${n * 250}–${(n + 1) * 250}`;
    default:
      return n >= 10 ? "10" : `${n}–${n + 1}`;
  }
}

/**
 * The embed shared by milestone notifications and the progress button: the
 * metric card in Discord form — overall gauge, next milestone and, for count
 * metrics, the per-bucket completion gauges of the card's breakdown.
 */
function metricEmbed(
  title: string,
  p: MetricParams,
  r: {
    count: number;
    total: number;
    step: number;
    byBucket: { bucket: number | string; value: number; total: number }[];
  },
  o: { headline?: string; conds?: string }
): Embed {
  const down = p.kind === "count" && p.descending === true;
  const lines: string[] = [];
  if (o.headline) lines.push(o.headline);
  if (p.kind === "count" && r.total > 0) {
    const pct = ((down ? r.total - r.count : r.count) / r.total) * 100;
    lines.push(
      `**${fmtInt(r.count)}**${down ? " left" : ""} / ${fmtInt(r.total)} (${pct.toFixed(2)}%${down ? " done" : ""})`
    );
    lines.push(gauge(pct));
  } else {
    lines.push(`**${fmtInt(r.count)}**${down ? " left" : ""}`);
  }
  if (r.step > 0) {
    const next = down
      ? Math.max(0, (Math.ceil(r.count / r.step) - 1) * r.step)
      : (Math.floor(r.count / r.step) + 1) * r.step;
    const pct =
      p.stepPct === true && p.kind === "count" && r.total > 0
        ? ` (${((next / r.total) * 100).toFixed(1)}%)`
        : "";
    lines.push(`Next milestone: **${fmtInt(next)}**${pct}`);
  }
  if (p.kind === "count") {
    const dim = p.breakdown ?? "sr";
    const rows = r.byBucket.filter((b) => b.total > 0);
    if (rows.length > 0) {
      lines.push("", `**${BREAKDOWN_HEAD[dim] ?? "Breakdown"}**`);
      // one code span per row: label, bar and % align in the monospace font
      const lw = Math.max(...rows.map((b) => bucketLabel(dim, b.bucket).length));
      // every bucket is shown; the only cap is Discord's 4096-char description
      // (a whole 2007-2026 year breakdown fits with plenty of room)
      let used = lines.join("\n").length;
      let dropped = 0;
      for (const b of rows) {
        const pct = ((down ? b.total - b.value : b.value) / b.total) * 100;
        const row = `\`${bucketLabel(dim, b.bucket).padEnd(lw)} ${bar(pct, 20)}\` **${pct.toFixed(1)}%** · ${fmtInt(b.value)}${down ? " left" : ""} / ${fmtInt(b.total)}`;
        if (used + row.length + 30 > 3900) {
          dropped++;
          continue;
        }
        used += row.length + 1;
        lines.push(row);
      }
      if (dropped > 0) lines.push(`… ${fmtInt(dropped)} more`);
    }
  }
  const embed: Embed = {
    title: title.slice(0, 256),
    description: lines.join("\n").slice(0, 4000),
    color: PINK,
  };
  if (o.conds) embed.footer = { text: o.conds.slice(0, 2048) };
  return embed;
}

export function notifyMetricMilestones(): void {
  migrateGlobalToggles();
  // no metric-subscribed webhook: bail BEFORE stamping cooldowns, otherwise
  // a crossed milestone is consumed by a message that reaches zero channels
  if (!hasKindTarget("metric")) return;
  try {
    const rows = getDb()
      .prepare("SELECT id, name, params FROM metrics ORDER BY sort_order, id")
      .all() as { id: number; name: string; params: string }[];
    for (const r of rows) {
      let p: MetricParams;
      try {
        p = JSON.parse(r.params) as MetricParams;
      } catch {
        continue;
      }
      const result = evalMetric(p, "month");
      const { count, step } = result;
      if (!(step > 0)) continue;
      const down = p.kind === "count" && p.descending === true;
      // bucket index of the current count: floor going up, CEIL going down,
      // so landing exactly on a multiple counts as reaching it in both
      // directions (a countdown hitting "200 left" dead on used to be missed).
      // Completion (the whole pool: 0 left, or count = total) is its own
      // virtual bucket past the last step boundary, otherwise a pool whose
      // size is not a multiple of the step would finish silently.
      const rawBuck = down ? Math.ceil(count / step) : Math.floor(count / step);
      const done =
        p.kind === "count" &&
        result.total > 0 &&
        (down ? count <= 0 : count >= result.total);
      const buck = done ? (down ? -1 : rawBuck + 1) : rawBuck;
      const key = `metric_notify_floor_${r.id}`;
      const prevRaw = getState(key);
      // the step is stored with the bucket: bucket indices are meaningless
      // across steps, so an edited step (or a % step drifting as the pool
      // grows) re-baselines silently instead of posting phantom milestones
      const stamp = `${buck}@${step}`;
      if (stamp !== prevRaw) setState(key, stamp);
      if (prevRaw == null || prevRaw === "") continue; // baseline, no replay
      const [prevBuckRaw, prevStepRaw] = prevRaw.split("@");
      const prev = Number(prevBuckRaw);
      if (!Number.isFinite(prev)) continue;
      if (prevStepRaw != null && Number(prevStepRaw) !== step) continue;
      // only the progress direction notifies
      if (down ? buck >= prev : buck <= prev) continue;
      const atKey = `metric_notify_at_${r.id}`;
      const lastAt = Date.parse(getState(atKey) ?? "");
      if (Number.isFinite(lastAt) && Date.now() - lastAt < MILESTONE_COOLDOWN_MS)
        continue; // absorbed: the bucket moved, the next post shows it
      setState(atKey, new Date().toISOString());
      enqueue({
        kind: "metric",
        embeds: [
          metricEmbed(`Milestone: ${r.name}`, p, result, {
            headline: done
              ? down
                ? "**Completed**: 0 left"
                : `**Completed**: ${fmtInt(result.total)} / ${fmtInt(result.total)}`
              : down
                ? `Down to **${fmtInt(buck * step)}** left`
                : `**${fmtInt(buck * step)}** reached`,
          }),
        ],
      });
    }
  } catch (e) {
    logError(e, "discord metric milestones");
  }
}

/**
 * "Post progress" button on a metric card: one embed with the current state
 * and the next milestone. Server-side cooldown (shared by all metrics) so the
 * button cannot be spammed into the webhook. Returns an error string, or null.
 */
const PROGRESS_COOLDOWN_MS = 60_000;

/** "retry in Xs" while the key was stamped less than ms ago, else null */
function cooldownLeft(key: string, ms: number): string | null {
  const last = Date.parse(getState(key) ?? "");
  if (Number.isFinite(last) && Date.now() - last < ms) {
    const left = Math.ceil((ms - (Date.now() - last)) / 1000);
    return `cooldown: retry in ${left}s`;
  }
  return null;
}
const stampCooldown = (key: string): void =>
  setState(key, new Date().toISOString());
/** failed sends give the slot back: fixing a bad URL retries instantly */
const liftCooldown = (key: string): void => setState(key, "");

export function notifyMetricProgress(id: number, conds?: string): string | null {
  migrateGlobalToggles();
  if (getWebhookUrls().length === 0) return "no webhook URL configured";
  if (!hasKindTarget("metric")) return "no webhook receives metric posts (see the Milestones column)";
  const r = getDb()
    .prepare("SELECT id, name, params FROM metrics WHERE id = ?")
    .get(id) as { id: number; name: string; params: string } | undefined;
  if (!r) return "metric not found";
  // per metric: posting one metric's progress never locks the others
  const key = `metric_button_at_${id}`;
  const wait = cooldownLeft(key, PROGRESS_COOLDOWN_MS);
  if (wait) return wait;
  let p: MetricParams;
  try {
    p = JSON.parse(r.params) as MetricParams;
  } catch {
    return "corrupt metric";
  }
  const result = evalMetric(p, "month");
  stampCooldown(key);
  enqueue({ kind: "metric", embeds: [metricEmbed(`Metric: ${r.name}`, p, result, { conds })] });
  return null;
}

/** One message per poll tick (5 embeds max each, Discord allows 10). */
export function notifyBests(events: BestEvent[]): void {
  migrateGlobalToggles();
  if (events.length === 0 || !hasKindTarget("best")) return;
  void notifyBestsAsync(events);
}

async function notifyBestsAsync(events: BestEvent[]): Promise<void> {
  // fill what the API left out (cheap, cached files only): local pp for
  // unranked mod combos, the modded star rating on a cache miss
  for (const e of events) await fillComputed(e);
  const author = profileAuthor();
  const clears = events.filter((e) => e.firstClear).length;
  const improved = events.length - clears;
  const summary = [
    clears > 0 ? `${clears} new clear${clears > 1 ? "s" : ""}` : "",
    improved > 0 ? `${improved} improved best${improved > 1 ? "s" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const CHUNK = 5;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    enqueue({
      kind: "best",
      content: events.length > 1 && i === 0 ? `**${summary}**` : undefined,
      embeds: slice.map((e) => bestEmbed(e, author)),
      // remembered for the late honors edit (deferred leaderboard confirms)
      meta: { events: slice, author },
    });
  }
}

/**
 * "Post a random best" button in the settings: a REAL best sampled from the
 * database, sent through the exact same embed pipeline as a live poll
 * notification (modded SR from cache, local pp estimate when official pp is
 * missing, top/country honors) — the fastest way to see the actual render.
 */
/** a random REAL best from the database, ready for the embed pipeline.
 * honors = only bests that are country #1 or global top 100 (falls back to
 * any best when there is none, so the button always shows something). */
function sampleBestEvent(ruleset: number, honors = false): BestEvent | null {
  const db = getDb();
  const s = db
    .prepare(
      `SELECT s.beatmap_id, s.rank, s.accuracy, s.fc_state,
         COALESCE(s.classic_total_score, s.total_score) AS score,
         s.total_score AS score_std,
         s.max_combo AS combo, s.pp, s.mods, s.statistics, s.ended_at,
         u.global_rank, u.country_first,
         (SELECT COUNT(*) FROM scores s2
           WHERE s2.beatmap_id = s.beatmap_id AND s2.ruleset = s.ruleset
             AND s2.passed = 1) AS n
       FROM beatmap_user u
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE u.ruleset = ?${
         honors
           ? " AND (u.country_first = 1 OR (u.global_rank IS NOT NULL AND u.global_rank <= 100))"
           : ""
       } ORDER BY RANDOM() LIMIT 1`
    )
    .get(ruleset) as
    | {
        beatmap_id: number;
        rank: string;
        accuracy: number;
        fc_state: number;
        score: number;
        score_std: number | null;
        combo: number;
        pp: number | null;
        mods: string;
        statistics: string;
        ended_at: string;
        global_rank: number | null;
        country_first: number;
        n: number;
      }
    | undefined;
  if (!s) return honors ? sampleBestEvent(ruleset) : null;
  let moddedSr: number | null = null;
  const played = srMods(s.mods);
  if (played.length > 0) {
    const hit = db
      .prepare(
        "SELECT star_rating FROM modded_sr WHERE beatmap_id = ? AND ruleset = ? AND mods = ?"
      )
      .get(s.beatmap_id, ruleset, srModsKey(played)) as
      | { star_rating: number | null }
      | undefined;
    moddedSr = hit?.star_rating ?? null;
  }
  return {
    beatmapId: s.beatmap_id,
    ruleset,
    firstClear: s.n === 1,
    grade: s.rank,
    accuracy: s.accuracy,
    fcState: s.fc_state,
    score: s.score,
    scoreStd: s.score_std,
    combo: s.combo,
    pp: s.pp,
    endedAt: s.ended_at,
    modsJson: s.mods,
    statisticsJson: s.statistics,
    moddedSr,
    globalRank: s.global_rank,
    countryFirst: s.country_first === 1,
  };
}

export async function sendTestBest(ruleset: number): Promise<string | null> {
  migrateGlobalToggles();
  if (getWebhookUrls().length === 0) return "no webhook URL configured";
  if (!hasKindTarget("best")) return "no webhook receives best notifications (see the Bests column)";
  const wait = cooldownLeft("discord_test_best_at", PROGRESS_COOLDOWN_MS);
  if (wait) return wait;
  // claim the slot BEFORE any await: two quick clicks both passed the check
  // during fillComputed and posted twice
  stampCooldown("discord_test_best_at");
  const e = sampleBestEvent(ruleset);
  if (!e) {
    liftCooldown("discord_test_best_at");
    return "no best score to sample yet";
  }
  await fillComputed(e);
  enqueue({
    kind: "best",
    content: "**Test**, display a random best",
    embeds: [bestEmbed(e, profileAuthor())],
  });
  return null;
}

/**
 * A random best rendered into template variables + embed chrome, for the
 * visual editor: the client renders the template locally against these and
 * shows a pixel-faithful Discord preview without posting anything.
 */
export async function sampleBestPreview(
  ruleset: number,
  honors = false
): Promise<{
  vars: Record<string, string>;
  cover: string | null;
  footer: string | null;
  author: { name: string; icon_url?: string } | null;
} | null> {
  const e = sampleBestEvent(ruleset, honors);
  if (!e) return null;
  await fillComputed(e);
  const m = mapRow(e.beatmapId);
  const a = profileAuthor();
  return {
    vars: templateVars(e, m),
    cover: m ? coverUrl(m.beatmapset_id) : null,
    footer: m
      ? `Mapset by ${m.creator}${m.ranked_date ? ` • Ranked ${m.ranked_date.slice(0, 10)}` : ""}`
      : null,
    author: a ? { name: a.name, icon_url: a.icon_url } : null,
  };
}

/** "Send a test message" button in the settings. */
export async function sendTest(): Promise<string | null> {
  const urls = getWebhookUrls();
  if (urls.length === 0) return "no webhook URL configured";
  const wait = cooldownLeft("discord_test_at", PROGRESS_COOLDOWN_MS);
  if (wait) return wait;
  // claim the slot BEFORE the await (double-click posted twice); a failed
  // send gives it back so a corrected URL can be retested right away
  stampCooldown("discord_test_at");
  let firstErr: string | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [
            {
              title: "osu! completionist tracker",
              description: "Test notification: webhook configured correctly ✅",
              color: PINK,
              author: profileAuthor(),
            },
          ],
        }),
      });
      if (!res.ok) firstErr ??= `Discord answered HTTP ${res.status}`;
    } catch (e) {
      firstErr ??= String(e);
    }
  }
  if (firstErr) {
    liftCooldown("discord_test_at");
    return firstErr;
  }
  return null;
}
