import { describe, expect, it } from "vitest";
import { parseCollectionList } from "../logic/collectionList.js";

/**
 * Exact shape of the importer's `--list` output (C# interpolation
 * `$"  {name,-40} {count,6} map(s)   last modified {modified:yyyy-MM-dd}"`).
 */
const line = (name: string, count: number, date = "2026-08-01") =>
  `  ${name.padEnd(40)} ${String(count).padStart(6)} map(s)   last modified ${date}`;

describe("parseCollectionList", () => {
  it("reads a normal output and skips the header", () => {
    const out = ["", "2 collection(s) in lazer:", line("Farm", 128), line("To FC", 7, "2025-12-31"), ""].join("\n");
    expect(parseCollectionList(out)).toEqual([
      { name: "Farm", count: 128, lastModified: "2026-08-01" },
      { name: "To FC", count: 7, lastModified: "2025-12-31" },
    ]);
  });

  it("keeps inner spaces and names longer than the column", () => {
    const long = "a very long collection name that overflows the column";
    const out = [line("Missing  -  Ranked score", 3), line(long, 1)].join("\n");
    expect(parseCollectionList(out).map((c) => c.name)).toEqual([
      "Missing  -  Ranked score",
      long,
    ]);
  });

  it("empty name, and zero maps", () => {
    expect(parseCollectionList(line("", 0))).toEqual([
      { name: "", count: 0, lastModified: "2026-08-01" },
    ]);
  });

  it("unexpected output (old exe, error) => no collections", () => {
    expect(parseCollectionList("Unknown option: --list\n")).toEqual([]);
    expect(parseCollectionList("")).toEqual([]);
    expect(parseCollectionList("0 collection(s) in lazer:")).toEqual([]);
  });

  it("handles Windows line endings", () => {
    expect(parseCollectionList(`${line("Farm", 5)}\r\n`)).toHaveLength(1);
  });
});
