/**
 * Phase-1 feasibility check: prints the bundled runtime versions and whether
 * node:sqlite is available inside Electron (the utilityProcess that runs the
 * server uses this exact runtime). Run with: npm run desktop:check
 */
import { app } from "electron";

let sqlite = "MISSING";
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(a)");
  db.prepare("INSERT INTO t VALUES (?)").run(42);
  if (db.prepare("SELECT a FROM t").get().a === 42) sqlite = "OK";
} catch (e) {
  sqlite = `MISSING (${e instanceof Error ? e.message : e})`;
}

console.log(
  `electron ${process.versions.electron} | node ${process.versions.node} | chrome ${process.versions.chrome}`
);
console.log(`node:sqlite: ${sqlite}`);
app.quit();
