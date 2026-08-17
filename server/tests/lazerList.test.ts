import { describe, expect, it } from "vitest";
import { parseCollectionList } from "../logic/collectionList.js";

/**
 * Exact shape of the importer's `--list` output (C# interpolation
 * `$"  {name,-40} {count,6} map(s)   last modified {modified:yyyy-MM-dd}"`).
 */
const line = (name: string, count: number, date = "2026-08-01") =>
  `  ${name.padEnd(40)} ${String(count).padStart(6)} map(s)   last modified ${date}`;

describe("parseCollectionList", () => {
  it("lit une sortie normale et ignore l'en-tête", () => {
    const out = ["", "2 collection(s) in lazer:", line("Farm", 128), line("To FC", 7, "2025-12-31"), ""].join("\n");
    expect(parseCollectionList(out)).toEqual([
      { name: "Farm", count: 128, lastModified: "2026-08-01" },
      { name: "To FC", count: 7, lastModified: "2025-12-31" },
    ]);
  });

  it("garde les espaces internes et les noms plus longs que la colonne", () => {
    const long = "a very long collection name that overflows the column";
    const out = [line("Missing  -  Ranked score", 3), line(long, 1)].join("\n");
    expect(parseCollectionList(out).map((c) => c.name)).toEqual([
      "Missing  -  Ranked score",
      long,
    ]);
  });

  it("nom vide, et zéro map", () => {
    expect(parseCollectionList(line("", 0))).toEqual([
      { name: "", count: 0, lastModified: "2026-08-01" },
    ]);
  });

  it("sortie inattendue (ancien exe, erreur) => aucune collection", () => {
    expect(parseCollectionList("Unknown option: --list\n")).toEqual([]);
    expect(parseCollectionList("")).toEqual([]);
    expect(parseCollectionList("0 collection(s) in lazer:")).toEqual([]);
  });

  it("gère les fins de ligne Windows", () => {
    expect(parseCollectionList(`${line("Farm", 5)}\r\n`)).toHaveLength(1);
  });
});
