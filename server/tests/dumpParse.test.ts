import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseOsuBeatmapsSql, scanTuples } from "../sync/dumpParse.js";

/** Minimal osu_beatmaps.sql, columns in the dump's real order. */
const CREATE = [
  "CREATE TABLE `osu_beatmaps` (",
  "  `beatmap_id` mediumint(8) unsigned NOT NULL,",
  "  `beatmapset_id` mediumint(8) unsigned DEFAULT NULL,",
  "  `filename` varchar(150) DEFAULT NULL,",
  "  `playmode` tinyint(3) unsigned NOT NULL DEFAULT '0',",
  "  `approved` tinyint(4) NOT NULL DEFAULT '0',",
  "  `deleted_at` timestamp NULL DEFAULT NULL",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8;",
].join("\n");

const rows = (...tuples: string[]) =>
  `INSERT INTO \`osu_beatmaps\` VALUES ${tuples.join(",")};`;

/**
 * The real data.ppy.sh schema, trimmed to the shape that broke everything: the
 * four camelCase count* columns sit BEFORE playmode/approved/deleted_at, so
 * skipping them shifts every later column by 4 (playmode then reads diff_drain,
 * approved reads diff_size, deleted_at reads passcount).
 */
const REAL_CREATE = [
  "CREATE TABLE `osu_beatmaps` (",
  "  `beatmap_id` mediumint unsigned NOT NULL AUTO_INCREMENT,",
  "  `beatmapset_id` mediumint unsigned DEFAULT NULL,",
  "  `filename` varchar(150) DEFAULT NULL,",
  "  `countTotal` mediumint unsigned NOT NULL DEFAULT '0',",
  "  `countNormal` mediumint unsigned NOT NULL DEFAULT '0',",
  "  `countSlider` mediumint unsigned NOT NULL DEFAULT '0',",
  "  `countSpinner` mediumint unsigned NOT NULL DEFAULT '0',",
  "  `diff_drain` float unsigned NOT NULL DEFAULT '0',",
  "  `diff_size` float unsigned NOT NULL DEFAULT '0',",
  "  `playmode` tinyint unsigned NOT NULL DEFAULT '0',",
  "  `approved` tinyint NOT NULL DEFAULT '0',",
  "  `passcount` int unsigned NOT NULL DEFAULT '0',",
  "  `deleted_at` timestamp NULL DEFAULT NULL,",
  "  PRIMARY KEY (`beatmap_id`),",
  "  KEY `beatmapset_id` (`beatmapset_id`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;",
].join("\n");

async function parse(sql: string) {
  const out = [];
  for await (const d of parseOsuBeatmapsSql(Readable.from([sql]))) out.push(d);
  return out;
}

describe("scanTuples", () => {
  it("splits tuples and drops string contents (commas, quotes, escapes)", () => {
    const got = [
      ...scanTuples("INSERT INTO `t` VALUES (1,'a,b',2),(3,'it\\'s ok',4);"),
    ];
    expect(got).toEqual([
      ["1", "", "2"],
      ["3", "", "4"],
    ]);
  });

  it("keeps NULL distinguishable from a quoted value", () => {
    expect([...scanTuples("VALUES (1,NULL,'2024-01-01 00:00:00');")]).toEqual([
      ["1", "NULL", ""],
    ]);
  });
});

describe("parseOsuBeatmapsSql", () => {
  it("yields the numeric columns by name, whatever their position", async () => {
    const got = await parse(
      `${CREATE}\n${rows("(101,55,'a.osu',3,1,NULL)", "(102,55,'b.osu',0,4,NULL)")}\n`
    );
    expect(got).toEqual([
      { beatmapId: 101, setId: 55, playmode: 3, approved: 1, deleted: false },
      { beatmapId: 102, setId: 55, playmode: 0, approved: 4, deleted: false },
    ]);
  });

  it("flags soft-deleted diffs, which still carry their old ranked status", async () => {
    const got = await parse(
      `${CREATE}\n${rows(
        "(201,60,'live.osu',3,1,NULL)",
        "(202,60,'gone.osu',3,1,'2024-05-01 12:00:00')"
      )}\n`
    );
    // 202 was ranked when deleted: counting it as a hole no lookup can fill is
    // what made the same phantoms come back on every run
    expect(got.map((d) => [d.beatmapId, d.deleted])).toEqual([
      [201, false],
      [202, true],
    ]);
  });

  it("treats an older dump without deleted_at as nothing deleted", async () => {
    const noCol = CREATE.replace(
      ",\n  `deleted_at` timestamp NULL DEFAULT NULL",
      ""
    );
    const got = await parse(`${noCol}\n${rows("(301,70,'a.osu',1,2)")}\n`);
    expect(got).toEqual([
      { beatmapId: 301, setId: 70, playmode: 1, approved: 2, deleted: false },
    ]);
  });

  it("indexes camelCase columns too (a shift here made playmode read diff_drain)", async () => {
    //                     id set file cT  cN cSl cSp drain size mode approved pass deleted
    const live = "(53,3,'a.osu',100,67,15,1,3,5,2,1,61224,NULL)";
    const gone = "(54,3,'b.osu',151,102,23,1,5,7,3,4,54034,'2024-06-26 07:52:54')";
    expect(await parse(`${REAL_CREATE}\n${rows(live, gone)}\n`)).toEqual([
      { beatmapId: 53, setId: 3, playmode: 2, approved: 1, deleted: false },
      { beatmapId: 54, setId: 3, playmode: 3, approved: 4, deleted: true },
    ]);
  });

  it("refuses to compare when the columns look misaligned", async () => {
    // playmode/approved reading diff stats: out of their legal ranges
    const shifted = "(53,3,'a.osu',100,67,15,1,3,5,9,7,61224,NULL)";
    await expect(parse(`${REAL_CREATE}\n${rows(shifted)}\n`)).rejects.toThrow(
      /column alignment looks wrong/
    );
  });

  it("throws instead of yielding nothing when the file has no osu_beatmaps table", async () => {
    const other = CREATE.replace(/osu_beatmaps/g, "osu_beatmap_difficulty");
    await expect(parse(`${other}\n${rows("(1,2,'a',3,1,NULL)")}\n`)).rejects.toThrow(
      /no `osu_beatmaps` table/
    );
  });

  it("throws when a required column is missing", async () => {
    const broken = CREATE.replace("`playmode` tinyint(3) unsigned", "`mode` tinyint(3) unsigned");
    await expect(parse(`${broken}\n${rows("(1,2,'a',3,1,NULL)")}\n`)).rejects.toThrow(
      /missing column playmode/
    );
  });

  it("reassembles tuples split across stream chunks", async () => {
    const sql = `${CREATE}\n${rows("(401,80,'a.osu',2,1,NULL)", "(402,80,'b.osu',2,1,NULL)")}\n`;
    const chunks = [sql.slice(0, 120), sql.slice(120, 300), sql.slice(300)];
    const out = [];
    for await (const d of parseOsuBeatmapsSql(Readable.from(chunks))) out.push(d);
    expect(out.map((d) => d.beatmapId)).toEqual([401, 402]);
  });
});
