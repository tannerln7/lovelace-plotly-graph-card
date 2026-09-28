/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Represent a viewport-relative point without retaining a live browser Touch
 * object or a mutable TouchList.
 *
 * Responsibility:
 * Provide the shared coordinate value used for stable gesture anchors and
 * immutable contact snapshots.
 *
 * Interactions:
 * Recognizers create point values from observed touches. Sessions retain and
 * compare them. The Plotly adapter accepts them as semantic zoom anchors.
 *
 * Owns:
 * Coordinate data only.
 *
 * Must not:
 * Contain recognition thresholds, gesture policy, DOM hit testing, Plotly
 * axis math, or synthetic event construction.
 *
 * Future implementation:
 * Add geometry helpers here only when multiple recognizers or sessions share
 * the exact same operation. Gesture-specific calculations should remain in
 * their owning component.
 */
export interface ClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/** ARCHITECTURE SCAFFOLD: Shared identity-safe touch lookup and point math. */
export const findTouch = (
  touches: TouchList,
  identifier: number,
): Touch | undefined => {
  for (let index = 0; index < touches.length; index += 1) {
    if (touches[index].identifier === identifier) return touches[index];
  }
  return undefined;
};

export const touchPoint = (touch: Touch): ClientPoint => ({
  clientX: touch.clientX,
  clientY: touch.clientY,
});

export const touchContact = (
  touch: Touch,
  surface: PlotlyTouchSurface,
): TouchContactIdentity => ({
  identifier: touch.identifier,
  surface,
  start: touchPoint(touch),
});

export const touchDistance = (first: Touch, second: Touch): number =>
  Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
import type { TouchContactIdentity } from "./contracts";
import type { PlotlyTouchSurface } from "./plotly/contracts";
