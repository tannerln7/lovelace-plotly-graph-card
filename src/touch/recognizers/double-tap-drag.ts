import type {
  TouchContactIdentity,
  TouchRecognizer,
  TouchSession,
} from "../contracts";
import { findTouch, touchContact } from "../geometry";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/contracts";
import { DragZoomSession } from "../sessions/drag-zoom";

const DOUBLE_TAP_WINDOW_MS = 250;
const DOUBLE_TAP_PROXIMITY_PX = 30;
const DRAG_THRESHOLD_PX = 8;

interface CompletedTap {
  readonly contact: TouchContactIdentity;
  readonly completedAt: number;
}

type TapCandidate =
  | {
      readonly kind: "first";
      readonly contact: TouchContactIdentity;
    }
  | {
      readonly kind: "second";
      readonly contact: TouchContactIdentity;
      readonly observation: NativeGestureObservation;
    };

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Recognize the delayed second-touch drag that becomes custom drag zoom only
 * after its movement crosses Plotly's established drag threshold.
 *
 * Responsibility:
 * Retain the minimum clean first-tap candidate state, validate second-tap
 * timing/proximity/surface, permit second start and below-threshold movement
 * to remain native, then claim by returning a `DragZoomSession` exactly when
 * threshold classification becomes sticky.
 *
 * Interactions:
 * Called by `TouchController` only while unowned. It requests atomic semantic
 * takeover at claim and never sees later owned events unless ownership ends.
 *
 * Owns:
 * First-tap eligibility, timestamp, proximity origin, intended surface, second
 * contact origin, and sticky threshold-candidate state only.
 *
 * Must not:
 * Implement custom zoom, suppress either tap while merely observing, inspect
 * Plotly click fields, or encode the adapter's click-train reset mechanism.
 *
 * Implementation:
 * A valid first tap has exactly one contact, an eligible Cartesian surface, no
 * threshold-crossing movement, no second contact, and no cancellation. The
 * second tap must satisfy the Plotly-compatible timing window, proximity, and
 * same-surface rules. The crossing delta is handed to the claimed session and
 * applied exactly once when the controller routes the recognition event.
 */
export class DoubleTapDragRecognizer implements TouchRecognizer {
  /** ARCHITECTURE SCAFFOLD: One in-progress tap and one completed clean tap. */
  private candidate?: TapCandidate;
  private completedTap?: CompletedTap;

  constructor(private readonly plotly: PlotlyTouchAdapterContract) {}

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Observe one unowned event and optionally claim drag zoom.
   *
   * Responsibility:
   * Maintain the two-stage candidate and return a fully initialized session
   * only on sticky threshold crossing.
   *
   * Interactions:
   * Receives semantic adapter access directly; a returned session
   * receives the crossing event once through the controller.
   *
   * Owns:
   * One in-progress candidate plus the latest completed clean-tap match state.
   *
   * Must not:
   * Suppress native click/pan behavior before recognition succeeds.
   *
   * Implementation:
   * Preserve the second touch's initial origin/anchor and request atomic semantic
   * native takeover only at definitive claim. The adapter privately selects the
   * required pre-pan or post-pan path, including click-train cleanup.
   */
  handle(event: TouchEvent): TouchSession | undefined {
    if (event.type === "touchstart") return this.handleStart(event);
    if (event.type === "touchmove") return this.handleMove(event);
    if (event.type === "touchend") this.handleEnd(event);
    if (event.type === "touchcancel") this.reset();
    return undefined;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Invalidate the current first/second-tap candidate.
   *
   * Responsibility:
   * Clear every timing, contact, movement, and observation value so a later
   * physical sequence cannot continue an abandoned candidate.
   *
   * Interactions:
   * Called by the controller on any claim, ownership end, disable, or
   * disconnect and by future recognition logic on invalidating events.
   *
   * Owns:
   * Candidate cleanup only.
   *
   * Must not:
   * Reset Plotly's click train merely because this recognizer candidate ends;
   * that semantic adapter operation is reserved for actual custom takeover.
   *
   * Implementation:
   * Clear an observation lease before transferring it into a returned session;
   * otherwise release it through the adapter before dropping it. Releasing
   * this recognizer's lease must not tear down another recognizer's lease.
   */
  reset(): void {
    this.clearCandidate();
    this.completedTap = undefined;
  }

  private handleStart(event: TouchEvent): TouchSession | undefined {
    if (this.candidate || event.touches.length !== 1) {
      this.reset();
      return undefined;
    }

    const touch = event.touches[0];
    const surface = this.plotly.resolveSurface(touch);
    if (!surface) {
      this.completedTap = undefined;
      return undefined;
    }

    const contact = touchContact(touch, surface);
    const completed = this.completedTap;
    this.completedTap = undefined;
    if (completed && this.matchesCompletedTap(completed, contact)) {
      this.candidate = {
        kind: "second",
        contact,
        observation: this.plotly.acquireNativeObservation(
          surface,
          touch.identifier,
        ),
      };
    } else {
      this.candidate = { kind: "first", contact };
    }
    return undefined;
  }

  private handleMove(event: TouchEvent): TouchSession | undefined {
    const candidate = this.candidate;
    if (!candidate) return undefined;
    const touch = findTouch(event.touches, candidate.contact.identifier);
    if (event.touches.length !== 1 || !touch) {
      this.reset();
      return undefined;
    }
    if (!this.crossedThreshold(candidate.contact, touch)) return undefined;

    if (candidate.kind === "first") {
      this.candidate = undefined;
      return undefined;
    }

    if (!this.plotly.takeOverNativeGesture(candidate.observation)) {
      this.clearCandidate();
      return undefined;
    }

    const session = new DragZoomSession(
      this.plotly,
      candidate.observation,
      candidate.contact,
    );
    this.candidate = undefined;
    return session;
  }

  private handleEnd(event: TouchEvent): void {
    const candidate = this.candidate;
    if (!candidate) return;
    const ended = findTouch(event.changedTouches, candidate.contact.identifier);
    const cleanRelease =
      event.touches.length === 0 &&
      event.changedTouches.length === 1 &&
      Boolean(ended);

    this.candidate = undefined;
    if (candidate.kind === "second") {
      this.plotly.releaseNativeObservation(candidate.observation);
      return;
    }
    if (cleanRelease) {
      this.completedTap = {
        contact: candidate.contact,
        completedAt: Date.now(),
      };
    }
  }

  private matchesCompletedTap(
    completed: CompletedTap,
    contact: TouchContactIdentity,
  ): boolean {
    const elapsed = Date.now() - completed.completedAt;
    return (
      elapsed >= 0 &&
      elapsed < DOUBLE_TAP_WINDOW_MS &&
      completed.contact.surface === contact.surface &&
      Math.hypot(
        contact.start.clientX - completed.contact.start.clientX,
        contact.start.clientY - completed.contact.start.clientY,
      ) <= DOUBLE_TAP_PROXIMITY_PX
    );
  }

  private crossedThreshold(
    contact: TouchContactIdentity,
    touch: Touch,
  ): boolean {
    return (
      Math.max(
        Math.abs(touch.clientX - contact.start.clientX),
        Math.abs(touch.clientY - contact.start.clientY),
      ) >= DRAG_THRESHOLD_PX
    );
  }

  private clearCandidate(): void {
    if (this.candidate?.kind === "second") {
      this.plotly.releaseNativeObservation(this.candidate.observation);
    }
    this.candidate = undefined;
  }
}
