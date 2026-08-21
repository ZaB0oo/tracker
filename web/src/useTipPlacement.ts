import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/**
 * Places a hover tooltip by MEASURING it: rendered fixed, above the anchor
 * when its height fits the viewport, else below, clamped horizontally.
 * Shared by the completion bars, the rate histogram and the pack dots.
 *
 * `anchor` says WHICH element is hovered (the pack grid moves one tooltip
 * across thousands of dots, a boolean would go stale from dot to dot); it is
 * a callback ref typed as `Element` because the anchors are a div, a button
 * and an SVG rect alike.
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
