import { describe, expect, it } from "vitest";
import {
  parseLengthSeconds,
  parseSearch,
  parseStatus,
} from "../logic/searchQuery.js";

describe("parseSearch (osu!-style tokens)", () => {
  it("splits tokens from free text", () => {
    const r = parseSearch("ar>9 stars<6.5 nekomata master");
    expect(r.conds).toEqual([
      { key: "ar", op: ">", value: "9" },
      { key: "star", op: "<", value: "6.5" },
    ]);
    expect(r.text).toBe("nekomata master");
  });

  it("resolves aliases and ==", () => {
    const r = parseSearch("sr>=7 len<90 key==4 mapper=Sotarks");
    expect(r.conds).toEqual([
      { key: "star", op: ">=", value: "7" },
      { key: "length", op: "<", value: "90" },
      { key: "keys", op: "=", value: "4" },
      { key: "creator", op: "=", value: "Sotarks" },
    ]);
  });

  it("recognises the pack token", () => {
    const r = parseSearch("pack=S100 remainder");
    expect(r.conds).toEqual([{ key: "pack", op: "=", value: "S100" }]);
    expect(r.text).toBe("remainder");
  });

  it("keeps quoted values whole", () => {
    const r = parseSearch('creator="foo bar" hello');
    expect(r.conds).toEqual([{ key: "creator", op: "=", value: "foo bar" }]);
    expect(r.text).toBe("hello");
  });

  it("leaves unknown keys and stray = in the text", () => {
    const r = parseSearch("dj=ok a+b=c plain");
    expect(r.conds).toEqual([]);
    expect(r.text).toBe("dj=ok a+b=c plain");
  });

  it("keeps a digits-only query as text (id matching happens later)", () => {
    const r = parseSearch("129891");
    expect(r.conds).toEqual([]);
    expect(r.text).toBe("129891");
  });
});

describe("value parsing", () => {
  it("parses mm:ss lengths", () => {
    expect(parseLengthSeconds("1:30")).toBe(90);
    expect(parseLengthSeconds("90")).toBe(90);
    expect(parseLengthSeconds("10:05")).toBe(605);
    expect(Number.isNaN(parseLengthSeconds("abc"))).toBe(true);
  });

  it("parses statuses", () => {
    expect(parseStatus("r")).toBe(1);
    expect(parseStatus("Ranked")).toBe(1);
    expect(parseStatus("a")).toBe(2);
    expect(parseStatus("loved")).toBe(4);
    expect(parseStatus("graveyard")).toBeNull();
  });
});
