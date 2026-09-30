import type { TouchSession, TouchSessionResult } from "../contracts";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
} from "../plotly/contracts";

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Centralize the lifecycle that every recognized touch session shares without
 * turning gesture recognition or effects into a generic gesture framework.
 *
 * Responsibility:
 * Keep custom ownership sticky while contacts drain, suppress owned starts and
 * moves, let physical touchend reach Plotly's native cleanup, perform only the
 * researched zero-contact cancellation cleanup, and release or transfer one
 * native-observation lease exactly once.
 *
 * Interactions:
 * Concrete sessions implement only active gesture events. `TouchController`
 * sees the normal `TouchSession` contract; `PlotlyTouchAdapter` remains the
 * sole owner of Plotly-specific cleanup mechanics.
 *
 * Owns:
 * Shared drain, cancellation reentrancy, native-cleanup, and lease-ownership
 * state. Concrete sessions own contact identity and gesture-specific deltas.
 *
 * Must not:
 * Recognize a gesture, inspect Plotly state, calculate zoom, decide transfer
 * validity, suppress physical touchend, or synthesize cancellation cleanup for
 * controller disable/disconnect.
 *
 * Implementation:
 * `undefined` preserves ownership, `null` ends it, and a returned session
 * transfers ownership directly. A transferring session explicitly relinquishes
 * its lease without releasing it after constructing the replacement owner.
 */
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
    if (this.draining) return undefined;
    return this.handleOwnedEvent(event);
  }

  cancel(): void {
    this.releaseObservation();
  }

  protected abstract handleOwnedEvent(event: TouchEvent): TouchSessionResult;

  protected transferObservation(): void {
    this.observationOwned = false;
  }

  private handleEnd(event: TouchEvent): TouchSessionResult {
    // Plotly's document touchend closure must receive physical completion.
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
