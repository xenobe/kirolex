/**
 * DRAGGING THE DETAIL PANEL BIGGER — arithmetic only, because the native resizer does not work here.
 *
 * The panel used to rely on CSS `resize: both`. Measured in the running app: press the visual corner,
 * drag 120px, and the panel stays 584×619 with `style.width` still empty — the resizer never engages,
 * because the panel lives inside `.react-flow__viewport`, which is `transform: matrix(1.27…)`. A
 * transformed ancestor and a native resizer do not agree about where the corner is.
 *
 * So the drag is ours, and the one thing that makes it correct is dividing by the zoom: the pointer
 * moves in screen pixels while width and height are in the canvas's own pixels. Skip that and the panel
 * grows 1.27× too fast at this zoom and 6× too slow at 0.15 — which reads as "the handle is broken"
 * just as much as not moving at all does.
 */
export interface PanelSize {
  w: number;
  h: number;
}

/** Wide enough for a prompt line, short enough to stay inside the canvas; caps keep it from eating the app. */
export const PANEL_LIMITS = { minW: 300, minH: 160, maxW: 900, maxH: 820 };

export function resizePanel(
  start: PanelSize,
  dxScreen: number,
  dyScreen: number,
  zoom: number,
  limits: typeof PANEL_LIMITS = PANEL_LIMITS,
): PanelSize {
  // A zero or negative zoom would divide the drag into infinity; the canvas floor is 0.15, so anything
  // else is a caller that has not measured yet and 1 is the honest assumption.
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    w: clamp(start.w + dxScreen / z, limits.minW, limits.maxW),
    h: clamp(start.h + dyScreen / z, limits.minH, limits.maxH),
  };
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * NUDGE THE PANEL BACK INSIDE THE CANVAS — the other half of 「不要让其他东西显示在上面」.
 *
 * Measured in the running app: a card near the left edge opened its panel at `x = -143`, i.e. 634px left
 * of the canvas. `.react-flow` is `overflow: hidden`, so the panel was CLIPPED — the visible remainder
 * overlapped the sidebar, and the resize grip was somewhere off-screen. Raising z-index cannot fix that;
 * a panel that leaves its container is going to collide with whatever owns the space it lands in.
 *
 * So the panel is pushed back in: screen pixels measured, canvas pixels returned (the offset is applied
 * inside the scaled viewport, same as the size). Overflow on BOTH sides means the panel is wider than the
 * canvas — then the left/top edge wins, because a panel read from its start is still readable.
 */
export function fitInside(panel: Rect, canvas: Rect, zoom: number, margin = 8): { x: number; y: number } {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const axis = (lo: number, hi: number, cLo: number, cHi: number): number => {
    let d = 0;
    if (hi > cHi - margin) d = (cHi - margin) - hi;
    if (lo + d < cLo + margin) d = (cLo + margin) - lo;
    return d;
  };
  return {
    x: axis(panel.left, panel.right, canvas.left, canvas.right) / z,
    y: axis(panel.top, panel.bottom, canvas.top, canvas.bottom) / z,
  };
}
