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
import { PinchSession } from "../sessions/pinch";

/**
 * ARCHITECTURE SCAFFOLD:
 * Adapter-local mechanics remain opaque while this context pairs one observed
 * first contact with the lease that must either be released or transferred.
 */
interface PinchCandidate {
  readonly contact: TouchContactIdentity;
  readonly observation: NativeGestureObservation;
}

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Recognize when an unowned native one-finger interaction becomes a valid
 * same-surface two-contact custom pinch.
 *
 * Responsibility:
 * Track contact identity and original surface long enough to validate exactly
 * two eligible contacts, request one atomic semantic native takeover, and
 * return a `PinchSession`.
 *
 * Interactions:
 * Called by `TouchController` only while no owner exists. It may query the
 * Plotly adapter directly through its semantic contract; after returning a
 * session, it is reset and remains dormant until ownership ends.
 *
 * Owns:
 * Candidate contact IDs, candidate surface identity, and any opaque native
 * observation handle needed before recognition.
 *
 * Must not:
 * Suppress a first contact merely while observing, inspect `_dragdata` or
 * other Plotly fields, implement post-pan normalization, calculate pinch zoom,
 * or remain active beside an owning session.
 *
 * Implementation:
 * Intercept the second start in root capture only after both original targets
 * resolve to the same eligible surface. Request one atomic semantic native
 * takeover; the adapter selects its private pre-pan or post-pan mechanism. The
 * owning session handles the recognition event and subsequent drain behavior.
 */
export class PinchRecognizer implements TouchRecognizer {
  /**
   * ARCHITECTURE SCAFFOLD:
   * The sole unowned first-contact candidate. It observes native movement
   * without suppressing it and owns its lease until reset or successful claim.
   */
  private candidate?: PinchCandidate;

  constructor(private readonly plotly: PlotlyTouchAdapterContract) {}

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Observe one unowned event and optionally claim a pinch.
   *
   * Responsibility:
   * Perform only candidate tracking and definitive same-surface recognition.
   * Returning `undefined` means native Plotly/browser handling continues
   * untouched.
   *
   * Interactions:
   * Receives an injected semantic Plotly adapter; a returned session becomes the
   * controller's sole owner and receives this event once.
   *
   * Owns:
   * One first-contact identity and its opaque native-observation lease.
   *
   * Must not:
   * Prevent default or stop propagation unless this invocation also claims.
   *
   * Implementation:
   * Build `PinchSession` with identifier-based contacts and a fixed initial
   * midpoint after completing the appropriate semantic native handoff.
   */
  handle(event: TouchEvent): TouchSession | undefined {
    if (!this.candidate) {
      if (event.type === "touchstart" && event.touches.length === 1) {
        this.beginCandidate(event.touches[0]);
      }
      return undefined;
    }

    if (event.type === "touchstart") return this.tryClaim(event);
    if (
      event.type === "touchcancel" ||
      event.touches.length !== 1 ||
      !findTouch(event.touches, this.candidate.contact.identifier)
    ) {
      this.reset();
    }
    return undefined;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Forget all unowned pinch candidate state.
   *
   * Responsibility:
   * Release contact and native-observation state on claim, competing claim,
   * cancellation, disconnect, or return to the unowned lifecycle.
   *
   * Interactions:
   * Called centrally by `TouchController`; any adapter observation acquired by
   * this recognizer must be released here before state is discarded unless
   * the recognizer transferred that lease into the session it just returned.
   *
   * Owns:
   * Candidate cleanup only.
   *
   * Must not:
   * Cancel the active owner or alter card lifecycle callbacks.
   *
   * Implementation:
   * Clear transferred leases before returning a session. Pair every remaining
   * outstanding lease with `releaseNativeObservation` during reset. Other
   * recognizers may retain leases on the same adapter-owned record.
   */
  reset(): void {
    if (!this.candidate) return;
    this.plotly.releaseNativeObservation(this.candidate.observation);
    this.candidate = undefined;
  }

  private beginCandidate(touch: Touch): void {
    const surface = this.plotly.resolveSurface(touch);
    if (!surface) return;
    this.candidate = {
      contact: touchContact(touch, surface),
      observation: this.plotly.acquireNativeObservation(
        surface,
        touch.identifier,
      ),
    };
  }

  private tryClaim(event: TouchEvent): TouchSession | undefined {
    const candidate = this.candidate;
    if (!candidate || event.touches.length !== 2) {
      this.reset();
      return undefined;
    }

    const first = findTouch(event.touches, candidate.contact.identifier);
    const second = Array.from(event.touches).find(
      (touch) => touch.identifier !== candidate.contact.identifier,
    );
    if (
      !first ||
      !second ||
      this.plotly.resolveSurface(first) !== candidate.contact.surface ||
      this.plotly.resolveSurface(second) !== candidate.contact.surface
    ) {
      this.reset();
      return undefined;
    }

    if (!this.plotly.takeOverNativeGesture(candidate.observation)) {
      this.reset();
      return undefined;
    }

    const session = PinchSession.fromTouches(
      this.plotly,
      candidate.observation,
      [candidate.contact, touchContact(second, candidate.contact.surface)],
      [first, second],
    );
    this.candidate = undefined;
    return session;
  }
}
