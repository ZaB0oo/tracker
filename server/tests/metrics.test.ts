import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAP_CONDS,
  DEFAULT_SCORE_CONDS,
  mapWhere,
  scoreWhere,
  type MetricScoreConds,
} from "../logic/metrics.js";
import { poolWhere, statusIn } from "../logic/rulesets.js";

const conds = (over: Partial<MetricScoreConds>): MetricScoreConds => ({
  ...DEFAULT_SCORE_CONDS,
  ...over,
  counts: { ...DEFAULT_SCORE_CONDS.counts, ...(over.counts ?? {}) },
});

describe("scoreWhere", () => {
  it("always requires a passed score", () => {
    expect(scoreWhere(DEFAULT_SCORE_CONDS)).toContain("s.passed = 1");
  });

  it("inverts everything BUT the passed requirement (goal mode)", () => {
    const goal = conds({
      counts: {
        ...DEFAULT_SCORE_CONDS.counts,
        n50: { min: null, max: 0 },
        nMiss: { min: null, max: 0 },
        imperfections: { min: null, max: 1 },
      },
    });
    const inv = scoreWhere(goal, true);
    // "a passed best that does NOT meet the goal" — the complement is exact
    // only if passed stays outside the negation
    expect(inv.startsWith("s.passed = 1 AND NOT (")).toBe(true);
    expect(inv).not.toContain("NOT (s.passed = 1");
    // and it still mentions every bound of the goal
    expect(inv).toContain("$.meh");
    expect(inv).toContain("$.miss");
    expect(inv).toContain("slider_tail_hit");
  });

  it("an empty goal matches nothing once inverted", () => {
    // NOT(1) — an inverted metric with no condition must not select every map
    expect(scoreWhere(DEFAULT_SCORE_CONDS, true)).toBe("s.passed = 1 AND NOT (1)");
  });

  it("rejects mods that are not plain acronyms (injection guard)", () => {
    const sql = scoreWhere(conds({ requiredMods: ["HD", "'; DROP TABLE scores--"] }));
    expect(sql).toContain("'HD'");
    expect(sql).not.toContain("DROP");
  });

  it("rejects statistic keys that are not lowercase identifiers", () => {
    const sql = scoreWhere(
      conds({ hits: { large_tick_hit: { min: 1, max: null }, "a'b": { min: 1, max: null } } })
    );
    expect(sql).toContain("$.large_tick_hit");
    expect(sql).not.toContain("a'b");
  });
});

describe("mapWhere", () => {
  it("escapes quotes in the free-text query", () => {
    const sql = mapWhere({ ...DEFAULT_MAP_CONDS, query: "d'artagnan" });
    expect(sql).toContain("'%d''artagnan%'");
  });

  it("keeps only integer beatmap ids", () => {
    const sql = mapWhere({
      ...DEFAULT_MAP_CONDS,
      ids: [123, -4, 1.5, Number.NaN] as number[],
    });
    expect(sql).toContain("b.id IN (123)");
  });

  it("falls back to every status when none is selected", () => {
    expect(mapWhere(DEFAULT_MAP_CONDS)).toContain("b.status IN (1,2,4)");
  });
});

describe("statusIn (dashboard scope)", () => {
  it("maps the three scopes", () => {
    expect(statusIn("ranked")).toBe("(1, 2)");
    expect(statusIn("loved")).toBe("(4)");
    expect(statusIn("all")).toBe("(1, 2, 4)");
    expect(statusIn(undefined)).toBe("(1, 2, 4)");
    expect(statusIn("nonsense")).toBe("(1, 2, 4)");
  });
});

describe("poolWhere", () => {
  it("never interpolates a non-numeric ruleset (injection guard)", () => {
    // the routes coerce with parseRulesetParam; this documents the contract
    expect(poolWhere(0, "all")).toBe("b.ruleset = 0");
    expect(poolWhere(3, "specific")).toBe("b.ruleset = 3");
    expect(poolWhere(3, "converts")).toBe("b.ruleset = 0");
    expect(poolWhere(3, "all")).toBe("(b.ruleset = 3 OR b.ruleset = 0)");
  });
});
