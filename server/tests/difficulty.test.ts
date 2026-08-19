import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The module reads its file cache next to the database, resolved once at
// import time: the temp folder has to be set before the import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-"));
process.env.DB_PATH = path.join(dir, "tracker.db");

/** A plain 200-circle map, enough for a stable rating without shipping one. */
function synthetic(): string {
  const head = [
    "osu file format v14",
    "",
    "[General]",
    "Mode: 0",
    "",
    "[Difficulty]",
    "HPDrainRate:5",
    "CircleSize:4",
    "OverallDifficulty:8",
    "ApproachRate:9",
    "SliderMultiplier:1.4",
    "SliderTickRate:1",
    "",
    "[TimingPoints]",
    "0,300,4,2,1,60,1,0",
    "",
    "[HitObjects]",
  ];
  const notes = Array.from({ length: 200 }, (_, i) =>
    `${64 + ((i * 97) % 400)},${64 + ((i * 53) % 250)},${1000 + i * 150},1,0,0:0:0:0:`
  );
  return [...head, ...notes].join("\n");
}

const MAP = 1;
fs.mkdirSync(path.join(dir, "beatmaps"), { recursive: true });
fs.writeFileSync(path.join(dir, "beatmaps", `${MAP}.osu`), synthetic());

const { localStarRating } = await import("../osu/difficulty.js");

describe("localStarRating", () => {
  // no test may reach the network, whatever the cache state
  const offline = vi.fn(() => Promise.reject(new Error("offline")));
  beforeAll(() => vi.stubGlobal("fetch", offline));
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rates a cached map without asking the network", async () => {
    const sr = await localStarRating(MAP, [], 0);
    expect(sr).toBeGreaterThan(0);
    expect(offline).not.toHaveBeenCalled();
  });

  it("rates a custom rate below the mod's default one", async () => {
    const slow = await localStarRating(MAP, [{ acronym: "DT", settings: { speed_change: 1.2 } }], 0);
    const std = await localStarRating(MAP, [{ acronym: "DT" }], 0);
    expect(slow).not.toBeNull();
    expect(std).not.toBeNull();
    expect(slow!).toBeLessThan(std!);
    expect(slow!).toBeGreaterThan((await localStarRating(MAP, [], 0))!);
  });

  it("reads the default rate the same way whether it is spelled out or not", async () => {
    const spelled = await localStarRating(MAP, [{ acronym: "DT", settings: { speed_change: 1.5 } }], 0);
    expect(spelled).toBe(await localStarRating(MAP, [{ acronym: "DT" }], 0));
  });

  it("converts to another ruleset", async () => {
    expect(await localStarRating(MAP, [], 1)).toBeGreaterThan(0);
  });

  it("returns null instead of a wrong rating when the file cannot be had", async () => {
    expect(await localStarRating(404404, [{ acronym: "DT" }], 0)).toBeNull();
  });
});
