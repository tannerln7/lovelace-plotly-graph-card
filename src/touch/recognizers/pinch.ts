import type {
  ClaimTouch,
  TouchContactIdentity,
  TouchRecognizer,
} from "../contracts";
import {
  findTouch,
  touchContact,
  touchDistance,
  touchPoint,
} from "../geometry";
import type { ClientPoint } from "../geometry";
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
interface SinglePinchCandidate {
  readonly kind: "single";
  readonly contact: TouchContactIdentity;
  readonly observation: NativeGestureObservation;
}

interface SimultaneousPinchCandidate {
  readonly kind: "simultaneous";
  readonly contacts: readonly [TouchContactIdentity, TouchContactIdentity];
  readonly observation: NativeGestureObservation;
  readonly anchor: ClientPoint;
  readonly initialSpread: number;
}

type PinchCandidate = SinglePinchCandidate | SimultaneousPinchCandidate;

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Recognize when an unowned native interaction becomes a valid same-surface
 * two-contact custom pinch.
 *
 * Responsibility:
 * Track contact identity and original surface long enough to validate exactly
 * two eligible contacts, request one atomic semantic native takeover, and
 * request ownership of a `PinchSession`.
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
 * A staggered second start claims immediately after both original targets
 * resolve to one surface. When the first observed start already contains two
 * contacts, retain their initial geometry without suppression and claim on the
 * first valid move, after Plotly has initialized its native state. The adapter
 * selects its private pre-pan or post-pan takeover mechanism in either path.
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
  handle(event: TouchEvent, claim: ClaimTouch): void {
    if (!this.candidate) {
      if (event.type === "touchstart") {
        if (event.touches.length === 1) {
          this.beginSingleCandidate(event.touches[0]);
        } else if (event.touches.length === 2) {
          this.beginSimultaneousCandidate(event.touches[0], event.touches[1]);
        }
      }
      return;
    }

    if (this.candidate.kind === "simultaneous") {
      if (event.type === "touchmove") this.tryClaimSimultaneous(event, claim);
      else this.reset();
      return;
    }

    if (event.type === "touchstart") {
      this.tryClaimStaggered(event, claim);
      return;
    }
    if (
      event.type === "touchcancel" ||
      event.touches.length !== 1 ||
      !findTouch(event.touches, this.candidate.contact.identifier)
    ) {
      this.reset();
    }
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

  private beginSingleCandidate(touch: Touch): void {
    const surface = this.plotly.resolveSurface(touch);
    if (!surface) return;
    this.candidate = {
      kind: "single",
      contact: touchContact(touch, surface),
      observation: this.plotly.acquireNativeObservation(
        surface,
        touch.identifier,
      ),
    };
  }

  private beginSimultaneousCandidate(first: Touch, second: Touch): void {
    const surface = this.plotly.resolveSurface(first);
    if (!surface || this.plotly.resolveSurface(second) !== surface) return;

    const firstPoint = touchPoint(first);
    const secondPoint = touchPoint(second);
    this.candidate = {
      kind: "simultaneous",
      contacts: [touchContact(first, surface), touchContact(second, surface)],
      observation: this.plotly.acquireNativeObservation(
        surface,
        first.identifier,
      ),
      anchor: {
        clientX: (firstPoint.clientX + secondPoint.clientX) / 2,
        clientY: (firstPoint.clientY + secondPoint.clientY) / 2,
      },
      initialSpread: touchDistance(first, second),
    };
  }

  private tryClaimStaggered(event: TouchEvent, claim: ClaimTouch): void {
    const candidate = this.candidate;
    if (
      !candidate ||
      candidate.kind !== "single" ||
      event.touches.length !== 2
    ) {
      this.reset();
      return;
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
      return;
    }

    if (!this.plotly.takeOverNativeGesture(candidate.observation)) {
      this.reset();
      return;
    }

    const session = PinchSession.fromTouches(
      this.plotly,
      candidate.observation,
      [candidate.contact, touchContact(second, candidate.contact.surface)],
      [first, second],
    );
    this.candidate = undefined;
    if (!claim(session)) session.cancel();
  }

  private tryClaimSimultaneous(event: TouchEvent, claim: ClaimTouch): void {
    const candidate = this.candidate;
    if (
      !candidate ||
      candidate.kind !== "simultaneous" ||
      event.touches.length !== 2
    ) {
      this.reset();
      return;
    }

    const first = findTouch(event.touches, candidate.contacts[0].identifier);
    const second = findTouch(event.touches, candidate.contacts[1].identifier);
    const surface = candidate.contacts[0].surface;
    if (
      !first ||
      !second ||
      this.plotly.resolveSurface(first) !== surface ||
      this.plotly.resolveSurface(second) !== surface
    ) {
      this.reset();
      return;
    }

    if (!this.plotly.takeOverNativeGesture(candidate.observation)) {
      this.reset();
      return;
    }

    const session = new PinchSession(
      this.plotly,
      candidate.observation,
      candidate.contacts,
      candidate.anchor,
      candidate.initialSpread,
    );
    this.candidate = undefined;
    if (!claim(session)) session.cancel();
  }
}
