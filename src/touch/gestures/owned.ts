import type { TouchSession, TouchSessionResult } from "../contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/adapter";

export abstract class OwnedTouchSession implements TouchSession {
  abstract readonly changesViewport: boolean;
  protected draining = false;
  private nativeCleanupPending = true;
  private cancellationCleanupRunning = false;
  private observationOwned = true;

  protected constructor(
    protected readonly plotly: PlotlyTouchAdapterContract,
    protected readonly observation: NativeGestureObservation,
  ) {}

  handle(event: TouchEvent): TouchSessionResult {
    if (this.cancellationCleanupRunning) return undefined;
    if (event.type === "touchend") return this.handleEnd(event);
    if (event.type === "touchcancel") return this.handleCancel(event);

    this.suppress(event);
    if (!this.draining) return this.handleOwnedEvent(event);
    return undefined;
  }

  cancel(): void {
    this.releaseObservation();
  }

  protected abstract handleOwnedEvent(event: TouchEvent): TouchSessionResult;

  protected transferObservation(): void {
    this.observationOwned = false;
  }

  private handleEnd(event: TouchEvent): TouchSessionResult {
    // Plotly's document touchend must run to remove its native listeners.
    this.nativeCleanupPending = false;
    if (event.touches.length > 0) {
      this.draining = true;
      return undefined;
    }
    this.releaseObservation();
    return null;
  }

  private handleCancel(event: TouchEvent): TouchSessionResult {
    this.suppress(event);
    this.draining = true;
    if (event.touches.length > 0) return undefined;

    if (this.nativeCleanupPending) {
      this.cancellationCleanupRunning = true;
      try {
        this.plotly.cleanupCancelledGesture(this.observation, event);
      } finally {
        this.cancellationCleanupRunning = false;
      }
    }
    this.releaseObservation();
    return null;
  }

  private suppress(event: TouchEvent): void {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  private releaseObservation(): void {
    if (!this.observationOwned) return;
    this.observationOwned = false;
    this.plotly.releaseNativeObservation(this.observation);
  }
}
