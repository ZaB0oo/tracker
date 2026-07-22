import { getDb, getState, setState } from "../db/db.js";

const logError = (e: unknown, ctx: string) =>
  console.error(`[${ctx}] ${e instanceof Error ? e.message : String(e)}`);

/**
 * Discord notifications via a channel webhook (no bot). The webhook URL and
 * per-event toggles live in the settings DB (never in the repo).
 *
 * Anti-spam by construction:
 * - best-score events are only emitted by the POLLING ingestion path (the
 *   backfill never notifies), and are batched into one embed per poll tick;
 * - country #1 events piggyback on country_events insertions, which already
 *   exclude the silent initial sweep (see applyCountryCheck).
 * Sending is fire-and-forget: a Discord outage never blocks the sync.
 */

const WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export interface DiscordSettings {
  webhookSet: boolean;
  bests: boolean;
  country: boolean;
}

export function getDiscordSettings(): DiscordSettings {
  return {
    webhookSet: Boolean(getState("discord_webhook_url")),
    bests: getState("discord_notify_bests") !== "0",
    country: getState("discord_notify_country") !== "0",
  };
}

export function setDiscordSettings(o: {
  webhookUrl?: string | null; // "" clears it
  bests?: boolean;
  country?: boolean;
}): string | null {
  if (o.webhookUrl != null) {
    const url = o.webhookUrl.trim();
    if (url !== "" && !WEBHOOK_RE.test(url))
      return "invalid webhook URL (expected https://discord.com/api/webhooks/...)";
    setState("discord_webhook_url", url);
  }
  if (o.bests != null) setState("discord_notify_bests", o.bests ? "1" : "0");
  if (o.country != null) setState("discord_notify_country", o.country ? "1" : "0");
  return null;
}

// ---------------------------------------------------------------- sending

interface Embed {
  title: string;
  description: string;
  color: number;
  url?: string;
}

const queue: Embed[] = [];
let draining = false;

function enqueue(embed: Embed): void {
  const url = getState("discord_webhook_url");
  if (!url) return;
  queue.push(embed);
  if (!draining) void drain(url);
}

async function drain(url: string): Promise<void> {
  draining = true;
  try {
    while (queue.length > 0) {
      const embed = queue[0];
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [embed] }),
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

// ---------------------------------------------------------------- content

const PINK = 0xff66aa;
const GOLD = 0xffd966;
const RED = 0xe05050;

function mapInfo(beatmapId: number): { label: string; sr: number | null } {
  const row = getDb()
    .prepare(
      `SELECT st.artist, st.title, b.version, b.star_rating
       FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
       WHERE b.id = ?`
    )
    .get(beatmapId) as
    | { artist: string; title: string; version: string; star_rating: number | null }
    | undefined;
  return row
    ? { label: `${row.artist} - ${row.title} [${row.version}]`, sr: row.star_rating }
    : { label: `beatmap ${beatmapId}`, sr: null };
}

const mapUrl = (beatmapId: number) => `https://osu.ppy.sh/beatmaps/${beatmapId}`;

const displayGrade = (g: string) => (g === "XH" ? "SSH" : g === "X" ? "SS" : g);

export interface BestEvent {
  beatmapId: number;
  firstClear: boolean;
  grade: string;
  accuracy: number; // 0..1
  fcState: number; // 0 PFC, 1 FC, 2+ non-FC
  score: number;
}

/** One embed per poll tick, however many new bests it contains. */
export function notifyBests(events: BestEvent[]): void {
  if (events.length === 0 || !getDiscordSettings().bests) return;
  const MAX_LINES = 10;
  const lines = events.slice(0, MAX_LINES).map((e) => {
    const { label, sr } = mapInfo(e.beatmapId);
    const fc = e.fcState === 0 ? " PFC" : e.fcState === 1 ? " FC" : "";
    const srTxt = sr != null ? ` ${sr.toFixed(2)}★` : "";
    return (
      `${e.firstClear ? "🆕" : "📈"} [${label}](${mapUrl(e.beatmapId)})${srTxt}\n` +
      `　　**${displayGrade(e.grade)}** · ${(e.accuracy * 100).toFixed(2)}%${fc} · ${e.score.toLocaleString("en-US")}`
    );
  });
  if (events.length > MAX_LINES) lines.push(`… and ${events.length - MAX_LINES} more`);
  const clears = events.filter((e) => e.firstClear).length;
  const improved = events.length - clears;
  const parts = [
    clears > 0 ? `${clears} new clear${clears > 1 ? "s" : ""}` : "",
    improved > 0 ? `${improved} improved best${improved > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  enqueue({ title: parts.join(" · "), description: lines.join("\n"), color: PINK });
}

export function notifyCountryEvent(
  beatmapId: number,
  event: "gained" | "lost",
  byUsername: string | null
): void {
  if (!getDiscordSettings().country) return;
  const { label, sr } = mapInfo(beatmapId);
  const srTxt = sr != null ? ` (${sr.toFixed(2)}★)` : "";
  if (event === "gained") {
    enqueue({
      title: "Country #1 gained",
      description: `🥇 [${label}](${mapUrl(beatmapId)})${srTxt}`,
      color: GOLD,
    });
  } else {
    enqueue({
      title: "Country #1 sniped",
      description:
        `💔 [${label}](${mapUrl(beatmapId)})${srTxt}` +
        (byUsername ? `\nby **${byUsername}**` : ""),
      color: RED,
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
            description: "Test notification — webhook configured correctly",
            color: PINK,
          },
        ],
      }),
    });
    return res.ok ? null : `Discord answered HTTP ${res.status}`;
  } catch (e) {
    return String(e);
  }
}
