/**
 * Regenerates server/db/seed-sets.json from a COMPLETE local database: the
 * list of every known ranked/approved/loved std beatmapset id, including
 * DMCA/delisted sets that /beatmapsets/search never returns. Fresh installs
 * use this list to import the sets their search enumeration cannot see.
 *
 * Usage: npm run export-seed   (server must be stopped, or use a backup copy)
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const dbPath = process.env.DB_PATH ?? "./data/tracker.db";
const d = new DatabaseSync(dbPath, { readOnly: true });
const ids = d
  .prepare(
    `SELECT DISTINCT st.id FROM beatmapsets st
     JOIN beatmaps b ON b.beatmapset_id = st.id
     WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) ORDER BY st.id`
  )
  .all()
  .map((r) => r.id);
fs.writeFileSync("server/db/seed-sets.json", JSON.stringify(ids));
console.log(`seed-sets.json: ${ids.length} set ids written`);
