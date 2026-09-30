import type {
  ClaimTouch,
  TouchContactIdentity,
  TouchRecognizer,
} from "../contracts";
import { findTouch, touchContact, touchPoint } from "../geometry";
import type { ClientPoint } from "../geometry";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/contracts";
import { HoverSession } from "../sessions/hover";

export const LONG_PRESS_MS = 300;
const MOVEMENT_TOLERANCE_PX = 8;

interface LongPressCandidate {
  readonly contact: TouchContactIdentity;
  readonly observation: NativeGestureObservation;
  readonly claim: ClaimTouch;
  current: ClientPoint;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Recognize stationary elapsed-time touch hover without asking the controller
 * to schedule or poll recognition.
 *
 * Responsibility:
 * Observe one eligible native contact, cancel on movement/shape changes, and
 * retain the controller's claim capability until the 300 ms timeout expires.
 *
 * Interactions:
 * The first contact remains entirely native while pending. On timeout this
 * recognizer performs the same atomic adapter takeover used by zoom gestures,
 * transfers its observation lease, and claims one initialized HoverSession.
 *
 * Owns:
 * One contact identity, current point, timer, opaque observation lease, and
 * the claim capability supplied for that exact candidate.
 *
 * Must not:
 * Suppress pending events, schedule through the controller, inspect Plotly
 * state, scrub hover after claim, or survive reset with a live timer/resource.
 *
 * Implementation:
 * Candidate identity plus timer cancellation is the stale-claim boundary.
 * JavaScript task serialization makes takeover and claim atomic with respect
 * to other recognizers; a rejected claim cancels the constructed session.
 */
export class LongPressRecognizer implements TouchRecognizer {
  private candidate?: LongPressCandidate;

  constructor(private readonly plotly: PlotlyTouchAdapterContract) {}

  handle(event: TouchEvent, claim: ClaimTouch): void {
    if (!this.candidate) {
      if (event.type === "touchstart" && event.touches.length === 1) {
        this.begin(event.touches[0], claim);
      }
      return;
    }

    if (event.type !== "touchmove") {
      this.reset();
      return;
    }

    const touch = findTouch(event.touches, this.candidate.contact.identifier);
    if (
      event.touches.length !== 1 ||
      !touch ||
      Math.max(
        Math.abs(touch.clientX - this.candidate.contact.start.clientX),
        Math.abs(touch.clientY - this.candidate.contact.start.clientY),
      ) >= MOVEMENT_TOLERANCE_PX
    ) {
      this.reset();
      return;
    }
    this.candidate.current = touchPoint(touch);
  }

  reset(): void {
    const candidate = this.candidate;
    if (!candidate) return;
    this.candidate = undefined;
    if (candidate.timer !== undefined) clearTimeout(candidate.timer);
    this.plotly.releaseNativeObservation(candidate.observation);
  }

  private begin(touch: Touch, claim: ClaimTouch): void {
    const surface = this.plotly.resolveSurface(touch);
    if (!surface) return;

    const candidate: LongPressCandidate = {
      contact: touchContact(touch, surface),
      observation: this.plotly.acquireNativeObservation(
        surface,
        touch.identifier,
      ),
      claim,
      current: touchPoint(touch),
    };
    candidate.timer = setTimeout(
      () => this.recognize(candidate),
      LONG_PRESS_MS,
    );
    this.candidate = candidate;
  }

  private recognize(candidate: LongPressCandidate): void {
    if (this.candidate !== candidate) return;
    if (!this.plotly.takeOverNativeGesture(candidate.observation)) {
      this.reset();
      return;
    }

    const session = new HoverSession(
      this.plotly,
      candidate.observation,
      candidate.contact,
      candidate.current,
    );
    this.candidate = undefined;
    if (candidate.timer !== undefined) clearTimeout(candidate.timer);
    if (candidate.claim(session)) session.activate();
    else session.cancel();
  }
}
