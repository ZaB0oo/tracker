import { config } from "../config.js";
import { getDb, getState, setState } from "../db/db.js";

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
}

export function getDiscordSettings(): DiscordSettings {
  return {
    webhookSet: Boolean(getState("discord_webhook_url")),
    bests: getState("discord_notify_bests") !== "0",
  };
}

export function setDiscordSettings(o: {
  webhookUrl?: string | null; // "" clears it
  bests?: boolean;
}): string | null {
  if (o.webhookUrl != null) {
    const url = o.webhookUrl.trim();
    if (url !== "" && !WEBHOOK_RE.test(url))
      return "invalid webhook URL (expected https://discord.com/api/webhooks/...)";
    setState("discord_webhook_url", url);
  }
  if (o.bests != null) setState("discord_notify_bests", o.bests ? "1" : "0");
  return null;
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
              st.creator, st.ranked_date, b.bpm, b.cs, b.ar, b.od, b.hp,
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
    const p = JSON.parse(getState("user_profile") || "null") as {
      username?: string;
      avatar_url?: string;
      country_code?: string;
      stats?: { pp?: number; global_rank?: number | null; country_rank?: number | null };
    } | null;
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

/** CS/AR/OD/HP · BPM · length, adjusted for HR/EZ and the play rate. */
function adjustedStats(m: MapRow, mods: ParsedMods): string {
  const mul = mods.hr ? 1.4 : mods.ez ? 0.5 : 1;
  const csMul = mods.hr ? 1.3 : mods.ez ? 0.5 : 1;
  const parts: string[] = [];

  if (m.total_length != null && m.total_length > 0) {
    const len = Math.round(m.total_length / mods.rate);
    parts.push(`${Math.floor(len / 60)}:${String(len % 60).padStart(2, "0")}`);
  }
  if (m.bpm != null && m.bpm > 0) parts.push(`${round1(m.bpm * mods.rate)} BPM`);
  if (m.cs != null) parts.push(`CS ${round1(Math.min(m.cs * csMul, 10))}`);
  if (m.ar != null) {
    // AR -> preempt ms, apply rate, back to AR (can exceed 10 with DT)
    const base = clamp10(m.ar * mul);
    const ms = base < 5 ? 1200 + 600 * ((5 - base) / 5) : 1200 - 750 * ((base - 5) / 5);
    const adj = ms / mods.rate;
    const ar = adj > 1200 ? 5 - (adj - 1200) / 120 : 5 + (1200 - adj) / 150;
    parts.push(`AR ${round1(ar)}`);
  }
  if (m.od != null) {
    // OD -> hit window ms (300), apply rate, back to OD
    const base = clamp10(m.od * mul);
    const ms = (80 - 6 * base) / mods.rate;
    parts.push(`OD ${round1((80 - ms) / 6)}`);
  }
  if (m.hp != null) parts.push(`HP ${round1(clamp10(m.hp * mul))}`);
  return parts.join(" · ");
}

/** lazer statistics JSON → "{300/100/50/miss}" */
function hitCounts(json: string): string | null {
  try {
    const s = JSON.parse(json) as {
      great?: number;
      ok?: number;
      meh?: number;
      miss?: number;
    };
    return `{${s.great ?? 0}/${s.ok ?? 0}/${s.meh ?? 0}/${s.miss ?? 0}}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- events

export interface BestEvent {
  beatmapId: number;
  firstClear: boolean;
  grade: string;
  accuracy: number; // 0..1
  fcState: number; // 0 PFC, 1 FC, 2+ non-FC
  score: number;
  combo: number;
  pp: number | null;
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

function bestEmbed(e: BestEvent, author: Embed["author"] | undefined): Embed {
  const m = mapRow(e.beatmapId);
  const mods = parseMods(e.modsJson);
  const sr = e.moddedSr ?? m?.star_rating ?? null;
  const srTxt = sr != null ? ` [${sr.toFixed(2)}★]` : "";
  const name = m ? `${m.artist} - ${m.title} [${m.version}]` : `beatmap ${e.beatmapId}`;
  const fc = e.fcState === 0 ? " PFC" : e.fcState === 1 ? " FC" : "";
  const when = Math.floor(Date.parse(e.endedAt) / 1000);

  const line1 = [
    `**${displayGrade(e.grade)}**${mods.label ? ` ${mods.label}` : ""}`,
    `**${e.score.toLocaleString("en-US")}**`,
    `${(e.accuracy * 100).toFixed(2)}%${fc}`,
    Number.isFinite(when) ? `<t:${when}:R>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const line2 = [
    m?.max_combo != null && m.max_combo > 0
      ? `**${e.combo}x**/${m.max_combo}x`
      : `**${e.combo}x**`,
    hitCounts(e.statisticsJson) ?? "",
    e.pp != null ? `**${e.pp.toFixed(2)}pp**` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [line1, line2];
  if (m) {
    const stats = adjustedStats(m, mods);
    if (stats) lines.push(stats);
  }
  const honors = [
    e.globalRank != null && e.globalRank <= 100 ? `🌍 **Global Top #${e.globalRank}**` : "",
    e.countryFirst
      ? `🥇 **country #1**${e.snipedUsername ? ` (sniped **${e.snipedUsername}**)` : ""}`
      : "",
  ].filter(Boolean);
  if (honors.length > 0) lines.push(honors.join(" · "));

  const embed: Embed = {
    title: `${e.firstClear ? "🆕" : "📈"} ${name}${srTxt}`.slice(0, 256),
    url: mapUrl(e.beatmapId),
    description: lines.join("\n"),
    color: PINK,
    author,
  };
  if (m) {
    embed.image = { url: coverUrl(m.beatmapset_id) };
    const ranked = m.ranked_date ? ` • Ranked ${m.ranked_date.slice(0, 10)}` : "";
    embed.footer = { text: `Mapset by ${m.creator}${ranked}` };
  }
  return embed;
}

/** One message per poll tick (5 embeds max each, Discord allows 10). */
export function notifyBests(events: BestEvent[]): void {
  if (events.length === 0 || !getDiscordSettings().bests) return;
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
            description: "Test notification — webhook configured correctly ✅",
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
