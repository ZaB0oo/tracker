import type React from "react";

/** Context-menu position, flipped up/left near the viewport edges so the menu
 * never opens off-screen (e.g. right-click on a bottom row). */
export function ctxMenuStyle(x: number, y: number): React.CSSProperties {
  const flipX = x > window.innerWidth - 320;
  const flipY = y > window.innerHeight - 300;
  return {
    left: x,
    top: y,
    transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
  };
}
