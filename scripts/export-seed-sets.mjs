/**
 * Regenerates server/db/seed-sets.json from a COMPLETE local database: every
 * known ranked/approved/loved beatmapset, ALL modes, including the DMCA/delisted
 * sets that /beatmapsets/search never returns. Fresh installs use this list to
 * import the sets their search enumeration cannot see.
 *
 * Format: { v: 2, sets: { "<set id>": <packed counts> } } — the number of diffs
 * per ruleset, 8 bits each (osu!, taiko, catch, mania). Counts, not flags: that
 * is what lets the catch-up spot a set holding SOME of a mode's diffs but not
 * all of them, and skip the modes the user does not track.
 *
 * Usage: npm run export-seed   (server must be stopped, or use a backup copy)
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const dbPath = process.env.DB_PATH ?? "./data/tracker.db";
const d = new DatabaseSync(dbPath, { readOnly: true });
const rows = d
  .prepare(
    `SELECT beatmapset_id AS id, ruleset, COUNT(*) n FROM beatmaps
     WHERE status IN (1, 2, 4)
     GROUP BY beatmapset_id, ruleset ORDER BY beatmapset_id`
  )
  .all();
const perSet = new Map();
for (const r of rows) {
  const c = perSet.get(r.id) ?? [0, 0, 0, 0];
  c[r.ruleset] = r.n;
  perSet.set(r.id, c);
}
const sets = {};
let diffs = [0, 0, 0, 0];
for (const [id, c] of perSet) {
  // 8 bits per ruleset, clamped (a single mode never has 255+ diffs in practice)
  sets[id] = c.reduce((acc, n, r) => acc | (Math.min(n, 255) << (8 * r)), 0);
  diffs = diffs.map((t, r) => t + c[r]);
}
fs.writeFileSync("server/db/seed-sets.json", JSON.stringify({ v: 2, sets }));
const perMode = [0, 1, 2, 3]
  .map((m) => `${["osu!", "taiko", "catch", "mania"][m]}: ${diffs[m]} diffs`)
  .join(", ");
console.log(`seed-sets.json: ${perSet.size} sets written (${perMode})`);
