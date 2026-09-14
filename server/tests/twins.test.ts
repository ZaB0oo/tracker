import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { computeRate, RATE_SQL } from "../logic/score.js";
import { MULT_SQL, roundMult } from "../logic/modMultiplier.js";

// vitest's resolver does not know the node:sqlite builtin yet: load it
// through Node directly (the modules under test carry no sqlite import).
type Db = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(): unknown[] } };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (p: string) => Db;
};

// The values materialized on `scores` have a JS twin (insert time) and a SQL
// twin (migration). Both must agree bit for bit, rounding included.

describe("rate: RATE_SQL vs computeRate", () => {
  const cases: { acronym: string; settings?: Record<string, number> }[][] = [
    [],
    [{ acronym: "HD" }],
    [{ acronym: "DT" }],
    [{ acronym: "NC" }],
    [{ acronym: "HT" }],
    [{ acronym: "DC" }],
    [{ acronym: "DT", settings: { speed_change: 1.3 } }],
    [{ acronym: "HT", settings: { speed_change: 0.65 } }],
    [{ acronym: "HR" }, { acronym: "DT", settings: { speed_change: 1.05 } }],
    [{ acronym: "WU" }],
    [{ acronym: "WD" }],
    [{ acronym: "AS" }],
    [{ acronym: "WU", settings: { initial_rate: 1.1, final_rate: 1.4 } }],
    [{ acronym: "WD", settings: { initial_rate: 0.9 } }],
    [{ acronym: "AS", settings: { initial_rate: 1.21 } }],
    // half-cent means: the reason the SQL rounds ROUND(x * 100) / 100
    [{ acronym: "WU", settings: { initial_rate: 1.0, final_rate: 1.21 } }],
    [{ acronym: "WU", settings: { initial_rate: 1.02, final_rate: 1.23 } }],
  ];
  it("agrees on every mod shape", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE scores (id INTEGER PRIMARY KEY, mods TEXT NOT NULL, rate REAL)");
    const ins = db.prepare("INSERT INTO scores (id, mods) VALUES (?, ?)");
    cases.forEach((mods, i) => ins.run(i + 1, JSON.stringify(mods)));
    db.exec(`UPDATE scores SET rate = ${RATE_SQL}`);
    const rows = db.prepare("SELECT id, rate FROM scores ORDER BY id").all() as {
      id: number;
      rate: number;
    }[];
    expect(rows.length).toBe(cases.length);
    for (const r of rows)
      expect(r.rate, JSON.stringify(cases[r.id - 1])).toBe(computeRate(cases[r.id - 1]));
  });
});

describe("mod_multiplier: MULT_SQL vs roundMult", () => {
  it("agrees on half-way values", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE scores (id INTEGER PRIMARY KEY, total_score INTEGER, nomod_score INTEGER, mod_multiplier REAL)"
    );
    const ins = db.prepare("INSERT INTO scores (id, total_score, nomod_score) VALUES (?, ?, ?)");
    const pairs: [number, number][] = [
      [1000000, 1000000],
      [1120000, 1000000],
      [980000, 1000000],
      // x.xxxx5 exactly: ROUND(x, 4) and ROUND(x * 10000) / 10000 can differ here
      [100005, 1000000],
      [100015, 1000000],
      [1234565, 1000000],
      [7, 8],
      [1, 3],
      [2, 3],
      [999999, 1000000],
      [1500001, 1000000],
    ];
    pairs.forEach(([t, n], i) => ins.run(i + 1, t, n));
    db.exec(`UPDATE scores SET mod_multiplier = ${MULT_SQL} WHERE nomod_score > 0`);
    const rows = db
      .prepare("SELECT id, mod_multiplier m FROM scores ORDER BY id")
      .all() as { id: number; m: number }[];
    expect(rows.length).toBe(pairs.length);
    for (const r of rows) {
      const [t, n] = pairs[r.id - 1];
      expect(r.m, `${t}/${n}`).toBe(roundMult(t / n));
    }
  });
});
