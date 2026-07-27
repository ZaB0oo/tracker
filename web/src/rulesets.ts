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
