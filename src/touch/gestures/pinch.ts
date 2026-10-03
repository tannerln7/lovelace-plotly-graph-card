import type {
  ClaimTouch,
  ClientPoint,
  TouchContactIdentity,
  TouchRecognizer,
  TouchSessionResult,
} from "../contracts";
import { findTouch, pointDistance, touchContact } from "../contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/adapter";
import { OwnedTouchSession } from "./owned";

type TouchPair = readonly [TouchContactIdentity, TouchContactIdentity];

interface PinchGeometry {
  readonly anchor: ClientPoint;
  readonly spread: number;
}

const pinchGeometry = (first: Touch, second: Touch): PinchGeometry => ({
  anchor: {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  },
  spread: pointDistance(first, second),
});

export class PinchSession extends OwnedTouchSession {
  readonly changesViewport = true;
  private readonly anchor: ClientPoint;
  private previousSpread: number;

  constructor(
    plotly: PlotlyTouchAdapterContract,
    observation: NativeGestureObservation,
    private readonly contacts: TouchPair,
    touches: readonly [Touch, Touch],
    initialGeometry?: PinchGeometry,
  ) {
    super(plotly, observation);
    const geometry = initialGeometry ?? pinchGeometry(...touches);
    this.anchor = geometry.anchor;
    this.previousSpread = geometry.spread;
  }

  protected handleOwnedEvent(event: TouchEvent): TouchSessionResult {
    const first = findTouch(event.touches, this.contacts[0].identifier);
    const second = findTouch(event.touches, this.contacts[1].identifier);
    if (event.touches.length !== 2 || !first || !second) {
      this.draining = true;
      return undefined;
    }

    if (event.type === "touchmove") {
      const spread = pointDistance(first, second);
      const delta = spread - this.previousSpread;
      this.previousSpread = spread;
      if (delta) this.plotly.zoom(this.contacts[0].surface, this.anchor, delta);
    }
    return undefined;
  }
}

interface PinchCandidate {
  readonly contacts: readonly [TouchContactIdentity, TouchContactIdentity?];
  readonly observation: NativeGestureObservation;
  readonly initial?: PinchGeometry;
}

export class PinchRecognizer implements TouchRecognizer {
  private candidate?: PinchCandidate;

  constructor(private readonly plotly: PlotlyTouchAdapterContract) {}

  handle(event: TouchEvent, claim: ClaimTouch): void {
    if (!this.candidate) {
      if (event.type === "touchstart") this.begin(event.touches);
      return;
    }

    const simultaneous = Boolean(this.candidate.contacts[1]);
    if (event.type === (simultaneous ? "touchmove" : "touchstart")) {
      this.tryClaim(event, claim);
    } else if (
      simultaneous ||
      event.type === "touchcancel" ||
      event.touches.length !== 1 ||
      !findTouch(event.touches, this.candidate.contacts[0].identifier)
    ) {
      this.reset();
    }
  }

  reset(): void {
    if (!this.candidate) return;
    this.plotly.releaseNativeObservation(this.candidate.observation);
    this.candidate = undefined;
  }

  private begin(touches: TouchList): void {
    if (touches.length !== 1 && touches.length !== 2) return;
    const first = touches[0];
    const surface = this.plotly.resolveSurface(first);
    if (!surface) return;

    const firstContact = touchContact(first, surface);
    const second = touches.length === 2 ? touches[1] : undefined;
    if (second && this.plotly.resolveSurface(second) !== surface) return;
    const observation = this.plotly.acquireNativeObservation(
      surface,
      first.identifier,
    );
    if (!second) {
      this.candidate = { contacts: [firstContact], observation };
      return;
    }

    // iOS may deliver both contacts in the first touchstart. Wait for move so
    // Plotly initializes native drag, retaining start geometry for its delta.
    this.candidate = {
      contacts: [firstContact, touchContact(second, surface)],
      observation,
      initial: pinchGeometry(first, second),
    };
  }

  private tryClaim(event: TouchEvent, claim: ClaimTouch): void {
    const candidate = this.candidate;
    if (!candidate || event.touches.length !== 2) {
      this.reset();
      return;
    }

    const firstContact = candidate.contacts[0];
    const storedSecond = candidate.contacts[1];
    const first = findTouch(event.touches, firstContact.identifier);
    const second = storedSecond
      ? findTouch(event.touches, storedSecond.identifier)
      : Array.from(event.touches).find(
          (touch) => touch.identifier !== firstContact.identifier,
        );
    if (
      !first ||
      !second ||
      this.plotly.resolveSurface(first) !== firstContact.surface ||
      this.plotly.resolveSurface(second) !== firstContact.surface ||
      !this.plotly.takeOverNativeGesture(candidate.observation)
    ) {
      this.reset();
      return;
    }

    const contacts: TouchPair = [
      firstContact,
      storedSecond ?? touchContact(second, firstContact.surface),
    ];
    const session = new PinchSession(
      this.plotly,
      candidate.observation,
      contacts,
      [first, second],
      candidate.initial,
    );
    this.candidate = undefined;
    if (!claim(session)) session.cancel();
  }
}
