import type { TouchContactIdentity, TouchSessionResult } from "../contracts";
import { findTouch, touchDistance, touchPoint } from "../geometry";
import type { ClientPoint } from "../geometry";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/contracts";
import { OwnedTouchSession } from "./owned";

type TouchPair = readonly [TouchContactIdentity, TouchContactIdentity];

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Own a recognized pinch from claim until the complete physical sequence
 * drains or is cancelled.
 *
 * Responsibility:
 * Track contacts by `Touch.identifier`, keep the initial midpoint fixed,
 * convert incremental spread changes to semantic adapter zoom requests, and
 * suppress owned starts/moves so native Plotly cannot re-enter mid-gesture,
 * while allowing physical touchend to reach Plotly's document cleanup.
 *
 * Interactions:
 * Created after semantic native takeover and routed exclusively by
 * `TouchController`. It calls only `PlotlyTouchAdapterContract` operations.
 *
 * Owns:
 * Identifier-keyed current positions, prior spread, fixed anchor, supported
 * versus draining state, and completion of its native observation context.
 *
 * Must not:
 * Use TouchList positions as identity, move the anchor, construct WheelEvents,
 * inspect Plotly axes/private fields, or resume native one-finger behavior
 * after partial release.
 *
 * Implementation:
 * Apply incremental spread delta while exactly the recognized contacts remain.
 * A partial release keeps ownership and drains; extra unsupported contacts stop
 * custom effects but remain suppressed until all owned contacts finish.
 */
export class PinchSession extends OwnedTouchSession {
  /**
   * ARCHITECTURE SCAFFOLD:
   * Build the same pinch owner from either recognizer claim or direct session
   * transfer. Callers retain contact identity policy; this factory alone
   * derives the fixed current midpoint and spread without retaining live
   * `Touch` objects.
   */
  static fromTouches(
    plotly: PlotlyTouchAdapterContract,
    observation: NativeGestureObservation,
    contacts: TouchPair,
    touches: readonly [Touch, Touch],
  ): PinchSession {
    const first = touchPoint(touches[0]);
    const second = touchPoint(touches[1]);
    return new PinchSession(
      plotly,
      observation,
      contacts,
      {
        clientX: (first.clientX + second.clientX) / 2,
        clientY: (first.clientY + second.clientY) / 2,
      },
      touchDistance(touches[0], touches[1]),
    );
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   * Gesture-specific mutable state is only the spread used for incremental
   * zoom. Shared drain, cancellation, suppression, and lease lifecycle state
   * lives in `OwnedTouchSession`.
   */
  private previousSpread: number;

  constructor(
    plotly: PlotlyTouchAdapterContract,
    observation: NativeGestureObservation,
    private readonly contacts: TouchPair,
    private readonly anchor: ClientPoint,
    initialSpread: number,
  ) {
    super(plotly, observation);
    this.previousSpread = initialSpread;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Process one event in the exclusively owned pinch sequence.
   *
   * Responsibility:
   * Suppress owned input, update contacts by identifier, emit at most one
   * semantic incremental zoom for each move, and report continue/end.
   *
   * Interactions:
   * Called only by the controller, including once for the recognition event.
   *
   * Owns:
   * Previous spread, sticky drain state, and exactly-once lease cleanup.
   *
   * Must not:
   * Return end on the first partial release or allow native handling to resume.
   *
   * Implementation:
   * On trusted zero-contact cancellation, invoke bounded adapter cleanup
   * synchronously before releasing ownership.
   */
  protected handleOwnedEvent(event: TouchEvent): TouchSessionResult {
    const first = findTouch(event.touches, this.contacts[0].identifier);
    const second = findTouch(event.touches, this.contacts[1].identifier);
    if (event.touches.length !== 2 || !first || !second) {
      this.draining = true;
      return undefined;
    }

    if (event.type === "touchmove") {
      const spread = touchDistance(first, second);
      const delta = spread - this.previousSpread;
      this.previousSpread = spread;
      if (delta !== 0) {
        this.plotly.zoom(this.contacts[0].surface, this.anchor, delta);
      }
    }
    return undefined;
  }
}
