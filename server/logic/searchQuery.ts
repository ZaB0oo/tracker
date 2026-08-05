/**
 * osu!-style search tokens, like the in-game/website beatmap search:
 * `ar>9 stars<6.5 status=r keys=7 creator=Sotarks length<1:30 remainder text`.
 * The tokens become SQL constraints, whatever is left is the free-text search.
 * A digits-only leftover also matches a beatmap/beatmapset id directly.
 */

export type SearchOp = "=" | "<" | ">" | "<=" | ">=";

export interface SearchCond {
  /** canonical key (aliases resolved: stars/sr -> star, len -> length…) */
  key: string;
  op: SearchOp;
  value: string;
}

const KEY_ALIASES: Record<string, string> = {
  star: "star", stars: "star", sr: "star",
  ar: "ar", od: "od", cs: "cs", hp: "hp", bpm: "bpm",
  length: "length", len: "length",
  key: "keys", keys: "keys",
  combo: "combo",
  status: "status",
  creator: "creator", mapper: "creator",
  artist: "artist", title: "title",
  year: "year", ranked: "year",
};

const TOKEN_RE = /^([a-z]+)(<=|>=|==|=|<|>)(.+)$/i;

/** `1:30` -> 90 (seconds); plain numbers pass through. NaN when unparsable. */
export function parseLengthSeconds(v: string): number {
  const mmss = /^(\d+):([0-5]?\d)$/.exec(v);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  return Number(v);
}

/** r/ranked -> 1, a/approved -> 2, l/loved -> 4; null when unknown. */
export function parseStatus(v: string): number | null {
  const s = v.toLowerCase();
  if (s === "r" || s === "ranked") return 1;
  if (s === "a" || s === "approved") return 2;
  if (s === "l" || s === "loved") return 4;
  return null;
}

/**
 * Splits the query into recognised tokens and the remaining free text.
 * Quoted values keep their spaces (`creator="foo bar"`); unknown keys stay in
 * the free text untouched (a title can legitimately contain `=`).
 */
export function parseSearch(q: string): { text: string; conds: SearchCond[] } {
  const conds: SearchCond[] = [];
  const rest: string[] = [];
  // split keeping quoted segments whole
  const parts = q.match(/(?:[^\s"]+"[^"]*"|"[^"]*"|[^\s"]+)/g) ?? [];
  for (const part of parts) {
    const m = TOKEN_RE.exec(part);
    if (!m) {
      rest.push(part);
      continue;
    }
    const key = KEY_ALIASES[m[1].toLowerCase()];
    if (!key) {
      rest.push(part);
      continue;
    }
    const op = (m[2] === "==" ? "=" : m[2]) as SearchOp;
    const value = m[3].replace(/^"|"$/g, "");
    conds.push({ key, op, value });
  }
  return { text: rest.join(" "), conds };
}
