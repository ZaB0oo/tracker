import { config } from "../config.js";
import { getDb, getState, setState } from "../db/db.js";
import { getStoredProfile } from "../osu/api.js";
import { localPp, localStarRating, perfHits } from "../osu/difficulty.js";
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
  bests: boolean;
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

export function getDiscordSettings(): DiscordSettings {
  return {
    webhookSet: Boolean(getState("discord_webhook_url")),
    bests: getState("discord_notify_bests") !== "0",
    template: getDiscordTemplate(),
  };
}

export function setDiscordSettings(o: {
  webhookUrl?: string | null; // "" clears it
  bests?: boolean;
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
    setState("discord_webhook_url", url);
  }
  if (o.bests != null) setState("discord_notify_bests", o.bests ? "1" : "0");
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
}

const queue: WebhookMessage[] = [];
let draining = false;

function enqueue(message: WebhookMessage): void {
  const url = getState("discord_webhook_url");
  if (!url) return;
  queue.push(message);
  if (!draining) void drain(url);
}

async function drain(url: string): Promise<void> {
  draining = true;
  try {
    while (queue.length > 0) {
      const message = queue[0];
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
          });
          if (res.status === 429) {
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
          break;
        } catch (e) {
          if (attempts >= 3) {
            logError(e, "discord webhook");
            break;
          }
          await sleep(2000);
        }
      }
      queue.shift();
    }
  } finally {
    draining = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    country1: e.countryFirst
      ? `🥇 **country #1**${e.snipedUsername ? ` (sniped **${e.snipedUsername}**)` : ""}`
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

/** One message per poll tick (5 embeds max each, Discord allows 10). */
export function notifyBests(events: BestEvent[]): void {
  if (events.length === 0 || !getDiscordSettings().bests) return;
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
    enqueue({
      content: events.length > 1 && i === 0 ? `**${summary}**` : undefined,
      embeds: events.slice(i, i + CHUNK).map((e) => bestEmbed(e, author)),
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
  const url = getState("discord_webhook_url");
  if (!url) return "no webhook URL configured";
  const e = sampleBestEvent(ruleset);
  if (!e) return "no best score to sample yet";
  await fillComputed(e);
  enqueue({
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
  const url = getState("discord_webhook_url");
  if (!url) return "no webhook URL configured";
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
    return res.ok ? null : `Discord answered HTTP ${res.status}`;
  } catch (e) {
    return String(e);
  }
}
