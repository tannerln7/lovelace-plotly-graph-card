import type { TouchContactIdentity, TouchSessionResult } from "../contracts";
import { findTouch, touchContact } from "../geometry";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/contracts";
import { PinchSession } from "./pinch";
import { OwnedTouchSession } from "./owned";

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Own delayed double-tap-drag zoom after threshold crossing.
 *
 * Responsibility:
 * Preserve the second touch's origin and anchor, convert incremental vertical
 * movement to semantic adapter zoom, suppress the owned sequence, and transfer
 * directly to `PinchSession` when a valid same-surface contact arrives.
 *
 * Interactions:
 * Created by `DoubleTapDragRecognizer`, routed exclusively by the controller,
 * and allowed to return a replacement pinch owner without ending card-level
 * custom ownership.
 *
 * Owns:
 * Active touch identity, prior vertical position, fixed anchor, drain state,
 * and native observation cleanup.
 *
 * Must not:
 * Re-run double-tap recognition, construct synthetic wheels, manipulate Plotly
 * private fields, or signal global end/start during a direct pinch transfer.
 *
 * Implementation:
 * Apply the threshold-crossing delta exactly once on the recognition event.
 * Resolve a later contact semantically and transfer only for a valid
 * same-surface pinch; otherwise safely drain unsupported contacts.
 */
export class DragZoomSession extends OwnedTouchSession {
  /**
   * ARCHITECTURE SCAFFOLD:
   * Gesture-specific mutable state is only the previous vertical coordinate.
   * Shared drain, cancellation, suppression, and lease lifecycle state lives
   * in `OwnedTouchSession`.
   */
  private previousClientY: number;

  constructor(
    plotly: PlotlyTouchAdapterContract,
    observation: NativeGestureObservation,
    private readonly contact: TouchContactIdentity,
  ) {
    super(plotly, observation);
    this.previousClientY = contact.start.clientY;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Process one event in the exclusively owned drag-zoom sequence.
   *
   * Responsibility:
   * Suppress the event, apply one incremental vertical zoom, end cleanly, or
   * return a direct pinch-session transfer.
   *
   * Interactions:
   * Called only by `TouchController`, including once for the recognition event.
   *
   * Owns:
   * Previous vertical position, sticky drain state, native-cleanup state, and
   * exactly-once lease ownership/transfer.
   *
   * Must not:
   * Route a transfer through a false card-level end/start lifecycle.
   *
   * Implementation:
   * Use `Touch.identifier` for continuity and the retained surface for both
   * zoom and same-surface transfer validation.
   */
  protected handleOwnedEvent(event: TouchEvent): TouchSessionResult {
    if (event.type === "touchstart") return this.handleAdditionalStart(event);

    const touch = findTouch(event.touches, this.contact.identifier);
    if (event.touches.length !== 1 || !touch) {
      this.draining = true;
      return undefined;
    }

    if (event.type === "touchmove") {
      const delta = touch.clientY - this.previousClientY;
      this.previousClientY = touch.clientY;
      if (delta !== 0) {
        this.plotly.zoom(this.contact.surface, this.contact.start, delta);
      }
    }
    return undefined;
  }

  private handleAdditionalStart(event: TouchEvent) {
    const first = findTouch(event.touches, this.contact.identifier);
    const second = Array.from(event.touches).find(
      (touch) => touch.identifier !== this.contact.identifier,
    );
    if (
      event.touches.length !== 2 ||
      !first ||
      !second ||
      this.plotly.resolveSurface(first) !== this.contact.surface ||
      this.plotly.resolveSurface(second) !== this.contact.surface
    ) {
      this.draining = true;
      return undefined;
    }

    const pinch = PinchSession.fromTouches(
      this.plotly,
      this.observation,
      [this.contact, touchContact(second, this.contact.surface)],
      [first, second],
    );
    this.transferObservation();
    return pinch;
  }
}
