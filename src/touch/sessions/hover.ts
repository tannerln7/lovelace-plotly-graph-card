import type { TouchContactIdentity, TouchSessionResult } from "../contracts";
import { findTouch, touchPoint } from "../geometry";
import type { ClientPoint } from "../geometry";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/contracts";
import { OwnedTouchSession } from "./owned";

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Own one long-press hover sequence from timed recognition through physical
 * completion without introducing a preview state or tooltip-specific owner.
 *
 * Responsibility:
 * Show hover immediately on activation, scrub it from identifier-matched
 * one-finger movement, suppress owned movement, and preserve the final hover
 * while the physical sequence drains.
 *
 * Interactions:
 * LongPressRecognizer constructs and activates this session only after the
 * controller accepts its timed claim. Shared lease/cancellation/drain behavior
 * remains in OwnedTouchSession; all hover rendering remains in the adapter.
 *
 * Owns:
 * One recognized contact identity and its latest viewport-relative point.
 *
 * Must not:
 * Inspect hover DOM, synthesize mouse events, manipulate Plotly internals,
 * clear hover on normal release, or transfer unsupported extra contacts.
 *
 * Implementation:
 * Any unsupported contact shape enters sticky draining. The controller's
 * generic final-touch bookend asks the adapter to restore this custom hover
 * after Plotly's native completion path has run.
 */
export class HoverSession extends OwnedTouchSession {
  readonly changesViewport = false;
  private current: ClientPoint;

  constructor(
    plotly: PlotlyTouchAdapterContract,
    observation: NativeGestureObservation,
    private readonly contact: TouchContactIdentity,
    current: ClientPoint,
  ) {
    super(plotly, observation);
    this.current = current;
  }

  /** Called only after the controller has accepted the timer-driven claim. */
  activate(): void {
    this.plotly.showHover(this.contact.surface, this.current);
  }

  protected handleOwnedEvent(event: TouchEvent): TouchSessionResult {
    const touch = findTouch(event.touches, this.contact.identifier);
    if (event.touches.length !== 1 || !touch) {
      this.draining = true;
      return undefined;
    }
    if (event.type === "touchmove") {
      this.current = touchPoint(touch);
      this.plotly.showHover(this.contact.surface, this.current);
    }
    return undefined;
  }
}
