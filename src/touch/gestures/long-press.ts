import type {
  ClaimTouch,
  ClientPoint,
  TouchContactIdentity,
  TouchRecognizer,
  TouchSessionResult,
} from "../contracts";
import {
  findTouch,
  pointMovement,
  touchContact,
  touchPoint,
} from "../contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/adapter";
import { OwnedTouchSession } from "./owned";

export const LONG_PRESS_MS = 300;
const MOVEMENT_TOLERANCE_PX = 8;

export class HoverSession extends OwnedTouchSession {
  readonly changesViewport = false;

  constructor(
    plotly: PlotlyTouchAdapterContract,
    observation: NativeGestureObservation,
    private readonly contact: TouchContactIdentity,
  ) {
    super(plotly, observation);
  }

  activate(point: ClientPoint): void {
    this.plotly.showHover(this.contact.surface, point);
  }

  handle(event: TouchEvent): TouchSessionResult {
    if (event.type !== "touchcancel" || event.touches.length) {
      return super.handle(event);
    }
    try {
      return super.handle(event);
    } finally {
      this.plotly.clearHover();
    }
  }

  cancel(): void {
    try {
      super.cancel();
    } finally {
      this.plotly.clearHover();
    }
  }

  protected handleOwnedEvent(event: TouchEvent): TouchSessionResult {
    const touch = findTouch(event.touches, this.contact.identifier);
    if (event.touches.length !== 1 || !touch) {
      this.draining = true;
      return undefined;
    }
    if (event.type === "touchmove") {
      this.plotly.showHover(this.contact.surface, touch);
    }
    return undefined;
  }
}

interface LongPressCandidate {
  readonly contact: TouchContactIdentity;
  readonly observation: NativeGestureObservation;
  readonly claim: ClaimTouch;
  current: ClientPoint;
  timer?: ReturnType<typeof setTimeout>;
}

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
      pointMovement(touch, this.candidate.contact.start) >=
        MOVEMENT_TOLERANCE_PX
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
    );
    this.candidate = undefined;
    if (candidate.claim(session)) session.activate(candidate.current);
    else session.cancel();
  }
}
