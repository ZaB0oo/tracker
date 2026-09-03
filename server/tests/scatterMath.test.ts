import { describe, expect, it } from "vitest";
import {
  ACC_FLOOR,
  makeInView,
  niceStep,
  scatterExtent,
} from "../../web/src/lib/scatterMath.js";

describe("niceStep", () => {
  it("picks a 1/2/5 step under the target count", () => {
    // span 10 with 12 targets: raw 0.833 -> 1
    expect(niceStep(10, 12, 0.1)).toBe(1);
    // span 4: raw 0.333 -> 0.5
    expect(niceStep(4, 12, 0.1)).toBe(0.5);
    // span 0.45 of accuracy with 9 targets: raw 0.05 -> 0.05
    expect(niceStep(0.45, 9, 0.005)).toBeCloseTo(0.05, 10);
  });
  it("never goes below the minimum", () => {
    expect(niceStep(0.001, 12, 0.1)).toBe(0.1);
  });
  it("scales up for huge spans (loved aspire hundreds of stars)", () => {
    const s = niceStep(900, 12, 0.1);
    expect(s).toBeGreaterThanOrEqual(900 / 12);
    expect([1, 2, 5].some((m) => s / m === 10 ** Math.round(Math.log10(s / m)))).toBe(true);
  });
});

describe("scatterExtent", () => {
  it("defaults to 10 on an empty cloud", () => {
    expect(scatterExtent([])).toBe(10);
  });
  it("keeps the full extent when the tail is proportionate", () => {
    // bulk up to ~8 stars plus real ranked 13-14 star maps: all in scale
    const srs = Array.from({ length: 1000 }, (_, i) => 1 + (i / 1000) * 7);
    srs.push(13.2, 14.1);
    expect(scatterExtent(srs)).toBe(14.5);
  });
  it("excludes only the out-of-scale aspire tail", () => {
    const srs = Array.from({ length: 1000 }, (_, i) => 1 + (i / 1000) * 7);
    srs.push(13.2, 950); // one aspire map must not stretch the axis
    expect(scatterExtent(srs)).toBe(13.5);
  });
  it("rounds up to the half star with a floor of 1", () => {
    expect(scatterExtent([0.3, 0.4])).toBe(1);
    expect(scatterExtent([6.26])).toBe(6.5);
  });
});

describe("makeInView", () => {
  const extent = 14.5;
  it("full view shows everything", () => {
    const vis = makeInView(null, extent);
    expect(vis(950, 0.99)).toBe(true);
    expect(vis(3, 0.2)).toBe(true);
  });
  it("an interior window cuts on all four sides", () => {
    const vis = makeInView({ x0: 3, x1: 6, a0: 0.9, a1: 0.98 }, extent);
    expect(vis(4, 0.95)).toBe(true);
    expect(vis(2.9, 0.95)).toBe(false);
    expect(vis(6.1, 0.95)).toBe(false);
    expect(vis(4, 0.89)).toBe(false);
    expect(vis(4, 0.99)).toBe(false);
  });
  it("a window touching the right edge keeps the edge-piled maps", () => {
    // the reported bug: zoom near the right edge and the 13+ star pile
    // (aspire maps beyond the extent) vanished, unreachable by any window
    const vis = makeInView({ x0: 10, x1: extent, a0: 0.9, a1: 1 }, extent);
    expect(vis(950, 0.95)).toBe(true); // piled on the edge, stays visible
    expect(vis(9, 0.95)).toBe(false); // left side still cuts normally
  });
  it("a window resting on the floor keeps sub-floor scores", () => {
    const vis = makeInView({ x0: 3, x1: 6, a0: ACC_FLOOR, a1: 0.8 }, extent);
    expect(vis(4, 0.2)).toBe(true); // piled on the floor line
    expect(vis(4, 0.81)).toBe(false); // top still cuts normally
  });
  it("a window away from the edges drops outliers as before", () => {
    const vis = makeInView({ x0: 3, x1: 6, a0: 0.9, a1: 0.98 }, extent);
    expect(vis(950, 0.95)).toBe(false);
    expect(vis(4, 0.2)).toBe(false);
  });
});
