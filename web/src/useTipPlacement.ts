import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/**
 * Places a hover tooltip by MEASURING it: rendered fixed, put above the
 * anchor when its actual height fits the viewport, else below, clamped
 * horizontally — it can never overflow the window. Shared by the completion
 * bars, the rate histogram and the pack dots.
 *
 * `anchor` says WHICH element is hovered, not merely whether one is: the pack
 * grid moves a single tooltip across thousands of dots, and a boolean would
 * stay truthy from dot to dot, leaving the tooltip measured against the one
 * it just left.
 *
 * The anchor is set through a callback ref rather than a RefObject: it is a
 * <div> for the bars, a <button> for the pack dots and an SVG <rect> for the
 * heatmap days, and one shared RefObject cannot be typed for all three. It is
 * an `Element` and not an HTML one for that same reason — getBoundingClientRect
 * is defined there, which is all this needs.
 */
export function useTipPlacement(anchor: unknown) {
  const wrapRef = useRef<Element | null>(null);
  const setWrap = useCallback((el: Element | null) => {
    wrapRef.current = el;
  }, []);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipStyle, setTipStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current || !wrapRef.current) return;
    const a = wrapRef.current.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    const above = a.top - tip.height - 7;
    const top = above >= 8 ? above : a.bottom + 7;
    const left = Math.max(
      8,
      Math.min(a.left + a.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8)
    );
    setTipStyle({ position: "fixed", top, left, bottom: "auto", transform: "none" });
  }, [anchor]);
  return { setWrap, tipRef, tipStyle, clearTip: () => setTipStyle(undefined) };
}
