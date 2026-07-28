/** Per-ruleset hit-statistic fields (mirror of server/logic/rulesets.ts). */
export const RULESET_NAMES: Record<number, string> = {
  0: "osu!",
  1: "taiko",
  2: "catch",
  3: "mania",
};

export const RULESET_HIT_FIELDS: Record<number, { key: string; label: string }[]> = {
  1: [
    { key: "great", label: "Greats" },
    { key: "ok", label: "Goods (150)" },
    { key: "miss", label: "Misses" },
  ],
  2: [
    { key: "great", label: "Fruits" },
    { key: "large_tick_hit", label: "Droplets" },
    { key: "small_tick_hit", label: "Tiny droplets" },
    { key: "small_tick_miss", label: "Tiny droplet misses" },
    { key: "miss", label: "Misses" },
  ],
  3: [
    { key: "perfect", label: "Perfects (305)" },
    { key: "great", label: "Greats (300)" },
    { key: "good", label: "Goods (200)" },
    { key: "ok", label: "Oks (100)" },
    { key: "meh", label: "Mehs (50)" },
    { key: "miss", label: "Misses" },
  ],
};

// Playable mods per ruleset, grouped by in-game category (source: osu-web
// database/mods.json, UserPlayable only — AT/CN/SV2 can't submit). "NM" is a
// virtual chip meaning "no mods" (CL alone still counts as nomod).
export interface ModGroup { label: string; mods: string[] }
export const RULESET_MOD_GROUPS: Record<number, ModGroup[]> = {
  0: [
    { label: "None", mods: ["NM"] },
    { label: "Reduction", mods: ["EZ", "NF", "HT", "DC"] },
    { label: "Increase", mods: ["HR", "SD", "PF", "DT", "NC", "HD", "TC", "FL", "BL", "ST", "AC"] },
    { label: "Automation", mods: ["RX", "AP", "SO"] },
    { label: "Conversion", mods: ["TP", "DA", "CL", "RD", "MR", "AL", "SG"] },
    { label: "Fun", mods: ["TR", "WG", "SI", "GR", "DF", "WU", "WD", "BR", "AD", "MU", "NS", "MG", "RP", "AS", "FR", "BU", "SY", "DP", "BM"] },
    { label: "System", mods: ["TD"] },
  ],
  1: [
    { label: "None", mods: ["NM"] },
    { label: "Reduction", mods: ["EZ", "NF", "HT", "DC", "SR"] },
    { label: "Increase", mods: ["HR", "SD", "PF", "DT", "NC", "HD", "FL", "AC"] },
    { label: "Automation", mods: ["RX"] },
    { label: "Conversion", mods: ["RD", "DA", "CL", "SW", "SG", "CS"] },
    { label: "Fun", mods: ["WU", "WD", "MU", "AS"] },
  ],
  2: [
    { label: "None", mods: ["NM"] },
    { label: "Reduction", mods: ["EZ", "NF", "HT", "DC"] },
    { label: "Increase", mods: ["HR", "SD", "PF", "DT", "NC", "HD", "FL", "AC"] },
    { label: "Automation", mods: ["RX"] },
    { label: "Conversion", mods: ["DA", "CL", "MR"] },
    { label: "Fun", mods: ["WU", "WD", "FF", "MU", "NS", "MF", "SY"] },
  ],
  3: [
    { label: "None", mods: ["NM"] },
    { label: "Reduction", mods: ["EZ", "NF", "HT", "DC", "NR"] },
    { label: "Increase", mods: ["HR", "SD", "PF", "DT", "NC", "FI", "HD", "CO", "FL", "AC"] },
    { label: "Conversion", mods: ["RD", "DS", "MR", "DA", "CL", "IN", "CS", "HO", "4K", "5K", "6K", "7K", "8K", "9K", "10K", "1K", "2K", "3K"] },
    { label: "Fun", mods: ["WU", "WD", "MU", "AS"] },
  ],
};

/** Map page URL in the given ruleset's tab (converts: ?m= keeps the mode). */
export function mapUrl(beatmapId: number, ruleset = 0): string {
  return `https://osu.ppy.sh/b/${beatmapId}${ruleset ? `?m=${ruleset}` : ""}`;
}

/**
 * Map stat fields that exist per ruleset: taiko has neither AR nor CS,
 * mania has no AR and its CS is the KEY COUNT. (OD/HP exist everywhere.)
 */
export function rulesetStatFields(r: number): { ar: boolean; cs: boolean; csLabel: string } {
  return { ar: r === 0 || r === 2, cs: r !== 1, csLabel: r === 3 ? "Keys" : "CS" };
}

/**
 * osu! mode icon (official wiki artwork, bundled in web/public/modes so the
 * share card's SVG -> canvas export stays same-origin and untainted).
 */
export function modeIcon(ruleset: number): string {
  return `/modes/${["osu", "taiko", "catch", "mania"][ruleset] ?? "osu"}.png`;
}
