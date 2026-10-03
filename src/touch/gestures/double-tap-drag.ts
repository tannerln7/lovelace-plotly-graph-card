import type {
  ClaimTouch,
  TouchContactIdentity,
  TouchRecognizer,
  TouchSessionResult,
} from "../contracts";
import {
  findTouch,
  pointDistance,
  pointMovement,
  touchContact,
} from "../contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/adapter";
import { OwnedTouchSession } from "./owned";
import { PinchSession } from "./pinch";

const DOUBLE_TAP_WINDOW_MS = 250;
const DOUBLE_TAP_PROXIMITY_PX = 30;
const DRAG_THRESHOLD_PX = 8;

export class DragZoomSession extends OwnedTouchSession {
  readonly changesViewport = true;
  private previousClientY: number;

  constructor(
    plotly: PlotlyTouchAdapterContract,
    observation: NativeGestureObservation,
    private readonly contact: TouchContactIdentity,
  ) {
    super(plotly, observation);
    this.previousClientY = contact.start.clientY;
  }

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
      if (delta)
        this.plotly.zoom(this.contact.surface, this.contact.start, delta);
    }
    return undefined;
  }

  private handleAdditionalStart(event: TouchEvent): TouchSessionResult {
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

    const pinch = new PinchSession(
      this.plotly,
      this.observation,
      [this.contact, touchContact(second, this.contact.surface)],
      [first, second],
    );
    this.transferObservation();
    return pinch;
  }
}

interface CompletedTap {
  readonly contact: TouchContactIdentity;
  readonly completedAt: number;
}

type TapCandidate =
  | { readonly kind: "first"; readonly contact: TouchContactIdentity }
  | {
      readonly kind: "second";
      readonly contact: TouchContactIdentity;
      readonly observation: NativeGestureObservation;
    };

export class DoubleTapDragRecognizer implements TouchRecognizer {
  private candidate?: TapCandidate;
  private completedTap?: CompletedTap;

  constructor(private readonly plotly: PlotlyTouchAdapterContract) {}

  handle(event: TouchEvent, claim: ClaimTouch): void {
    if (event.type === "touchstart") this.handleStart(event);
    if (event.type === "touchmove") this.handleMove(event, claim);
    if (event.type === "touchend") this.handleEnd(event);
    if (event.type === "touchcancel") this.reset();
  }

  reset(): void {
    this.clearCandidate();
    this.completedTap = undefined;
  }

  private handleStart(event: TouchEvent): void {
    if (this.candidate || event.touches.length !== 1) {
      this.reset();
      return;
    }

    const touch = event.touches[0];
    const surface = this.plotly.resolveSurface(touch);
    if (!surface) {
      this.completedTap = undefined;
      return;
    }

    const contact = touchContact(touch, surface);
    const completed = this.completedTap;
    this.completedTap = undefined;
    this.candidate =
      completed && this.matchesCompletedTap(completed, contact)
        ? {
            kind: "second",
            contact,
            observation: this.plotly.acquireNativeObservation(
              surface,
              touch.identifier,
            ),
          }
        : { kind: "first", contact };
  }

  private handleMove(event: TouchEvent, claim: ClaimTouch): void {
    const candidate = this.candidate;
    if (!candidate) return;
    const touch = findTouch(event.touches, candidate.contact.identifier);
    if (event.touches.length !== 1 || !touch) {
      this.reset();
      return;
    }
    if (pointMovement(touch, candidate.contact.start) < DRAG_THRESHOLD_PX)
      return;

    if (candidate.kind === "first") {
      this.candidate = undefined;
      return;
    }
    if (!this.plotly.takeOverNativeGesture(candidate.observation)) {
      this.clearCandidate();
      return;
    }

    const session = new DragZoomSession(
      this.plotly,
      candidate.observation,
      candidate.contact,
    );
    this.candidate = undefined;
    if (!claim(session)) session.cancel();
  }

  private handleEnd(event: TouchEvent): void {
    const candidate = this.candidate;
    if (!candidate) return;
    const cleanRelease =
      event.touches.length === 0 &&
      event.changedTouches.length === 1 &&
      Boolean(findTouch(event.changedTouches, candidate.contact.identifier));

    this.candidate = undefined;
    if (candidate.kind === "second") {
      this.plotly.releaseNativeObservation(candidate.observation);
    } else if (cleanRelease) {
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
      pointDistance(contact.start, completed.contact.start) <=
        DOUBLE_TAP_PROXIMITY_PX
    );
  }

  private clearCandidate(): void {
    if (this.candidate?.kind === "second") {
      this.plotly.releaseNativeObservation(this.candidate.observation);
    }
    this.candidate = undefined;
  }
}
