import type { PlotlyTouchSurface } from "./plotly/adapter";

export interface ClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export interface TouchContactIdentity {
  readonly identifier: number;
  readonly surface: PlotlyTouchSurface;
  readonly start: ClientPoint;
}

export type TouchSessionResult = TouchSession | null | undefined;

export interface TouchSession {
  readonly changesViewport: boolean;
  handle(event: TouchEvent): TouchSessionResult;
  cancel(): void;
}

// Accepted claims synchronously reset recognizers, so transfer candidate
// resources out of recognizer state before invoking claim().
export type ClaimTouch = (session: TouchSession) => boolean;

export interface TouchRecognizer {
  handle(event: TouchEvent, claim: ClaimTouch): void;
  reset(): void;
}

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

export const pointDistance = (
  first: ClientPoint,
  second: ClientPoint,
): number =>
  Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);

export const pointMovement = (
  point: ClientPoint,
  origin: ClientPoint,
): number =>
  Math.max(
    Math.abs(point.clientX - origin.clientX),
    Math.abs(point.clientY - origin.clientY),
  );
