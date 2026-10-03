import type { PlotlyTouchAdapterContract } from "./plotly/adapter";
import type {
  ClaimTouch,
  TouchRecognizer,
  TouchSession,
  TouchSessionResult,
} from "./contracts";
import { DoubleTapDragRecognizer } from "./gestures/double-tap-drag";
import { LongPressRecognizer } from "./gestures/long-press";
import { PinchRecognizer } from "./gestures/pinch";

const touchEvents = [
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
] as const;

interface RecognizerRegistration {
  readonly recognizer: TouchRecognizer;
  readonly enabled: () => boolean;
}

export interface TouchControllerOptions {
  readonly root: HTMLElement;
  readonly plotly: PlotlyTouchAdapterContract;
  readonly onGestureStart: () => void;
  readonly onGestureEnd: () => void;
}

export class TouchController {
  private zoomEnabled = true;
  private hoverEnabled = false;
  private connected = false;
  private owner?: TouchSession;
  private readonly recognizers: readonly RecognizerRegistration[];

  constructor(private readonly options: TouchControllerOptions) {
    this.recognizers = [
      {
        recognizer: new PinchRecognizer(options.plotly),
        enabled: () => this.zoomEnabled,
      },
      {
        recognizer: new DoubleTapDragRecognizer(options.plotly),
        enabled: () => this.zoomEnabled,
      },
      {
        recognizer: new LongPressRecognizer(options.plotly),
        enabled: () => this.hoverEnabled,
      },
    ];
  }

  get isEnabled(): boolean {
    return this.zoomEnabled;
  }

  set isEnabled(value: boolean) {
    if (this.zoomEnabled === value) return;
    this.zoomEnabled = value;
    this.cancelOwner();
    this.resetRecognizers();
  }

  get touchHoverEnabled(): boolean {
    return this.hoverEnabled;
  }

  set touchHoverEnabled(value: boolean) {
    if (this.hoverEnabled === value) return;
    this.hoverEnabled = value;
    this.cancelOwner();
    if (!value) this.options.plotly.clearHover();
    this.resetRecognizers();
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    for (const type of touchEvents) {
      this.options.root.addEventListener(type, this.onTouchEvent, {
        capture: true,
        passive: false,
      });
    }
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const type of touchEvents) {
      this.options.root.removeEventListener(type, this.onTouchEvent, true);
    }
    this.cancelOwner();
    this.resetRecognizers();
    this.options.plotly.clearHover();
  }

  private readonly onTouchEvent = (event: TouchEvent): void => {
    if (this.hoverEnabled) {
      if (event.type === "touchstart" && event.touches.length === 1) {
        this.options.plotly.clearHover();
      }
      if (
        event.isTrusted &&
        event.type === "touchend" &&
        event.touches.length === 0
      ) {
        this.options.plotly.reconcileNativeTouchEnd();
      }
    }

    if (!this.zoomEnabled && !this.hoverEnabled) return;
    if (this.owner) {
      this.applySessionResult(this.owner.handle(event));
      return;
    }

    for (const registration of this.recognizers) {
      if (!registration.enabled()) continue;
      registration.recognizer.handle(event, (session) =>
        registration.enabled() ? this.claim(session) : false,
      );
      // A retained callback may mutate `owner` inside `handle`; TypeScript's
      // local control-flow analysis cannot see that callback side effect.
      const claimedOwner = this.owner as TouchSession | undefined;
      if (claimedOwner) {
        this.applySessionResult(claimedOwner.handle(event));
        return;
      }
    }
  };

  private readonly claim: ClaimTouch = (session) => {
    if (this.owner) return false;
    this.owner = session;
    this.resetRecognizers();
    if (session.changesViewport) this.options.onGestureStart();
    return true;
  };

  private applySessionResult(result: TouchSessionResult): void {
    if (result === undefined) return;
    if (result) {
      const previousChangesViewport = this.owner?.changesViewport;
      this.owner = result;
      if (previousChangesViewport !== result.changesViewport) {
        if (previousChangesViewport) this.options.onGestureEnd();
        if (result.changesViewport) this.options.onGestureStart();
      }
      return;
    }
    const changedViewport = this.owner?.changesViewport;
    this.owner = undefined;
    if (changedViewport) this.options.onGestureEnd();
  }

  private cancelOwner(): void {
    if (!this.owner) return;
    const owner = this.owner;
    this.owner = undefined;
    owner.cancel();
    if (owner.changesViewport) this.options.onGestureEnd();
  }

  private resetRecognizers(): void {
    for (const { recognizer } of this.recognizers) recognizer.reset();
  }
}
