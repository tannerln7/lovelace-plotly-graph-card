import type { PlotlyTouchAdapterContract } from "./plotly/contracts";
import type {
  ClaimTouch,
  TouchRecognizer,
  TouchSession,
  TouchSessionResult,
} from "./contracts";
import { DoubleTapDragRecognizer } from "./recognizers/double-tap-drag";
import { LongPressRecognizer } from "./recognizers/long-press";
import { PinchRecognizer } from "./recognizers/pinch";

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

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Supply the stable root, semantic Plotly adapter, and card lifecycle callbacks
 * required by the new controller.
 *
 * Responsibility:
 * Define construction dependencies without exposing recognizer/session state
 * or Plotly-private mechanics to the card.
 *
 * Interactions:
 * `PlotlyGraph` constructs one adapter for its graph root and passes its
 * existing render-pause/resume behavior as callbacks.
 *
 * Owns:
 * Immutable construction inputs only.
 *
 * Must not:
 * Become a general dependency-injection container or plugin registry.
 *
 * Implementation:
 * Production constructs this contract directly through the public touch entry
 * point; legacy constructor compatibility stays outside this subsystem.
 */
export interface TouchControllerOptions {
  readonly root: HTMLElement;
  readonly plotly: PlotlyTouchAdapterContract;
  readonly onGestureStart: () => void;
  readonly onGestureEnd: () => void;
}

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Orchestrate independent recognizers and exactly one custom gesture owner on
 * the card's stable Plotly root.
 *
 * Responsibility:
 * Manage root capture-listener lifecycle, fixed recognizer priority, current
 * session ownership, recognizer resets, direct session transfer, and balanced
 * high-level card lifecycle callbacks.
 *
 * Interactions:
 * While unowned, events are offered to recognizers without suppression. On the
 * first accepted claim, all recognizers reset. A claim made synchronously from
 * `handle` receives that recognition event exactly once; a later timed claim
 * starts without a fabricated event. While owned, only the session receives
 * events. Sessions call the semantic Plotly adapter directly.
 *
 * Owns:
 * Connected/enabled state, fixed recognizer list, current owner, and callback
 * balancing. No custom `plotly` owner exists: no claim means native behavior.
 *
 * Must not:
 * Recognize pinch, double-tap, or long-press timing; query Plotly
 * surfaces/private fields; construct compatibility events; process relayout
 * payloads; or coordinate foreign graphs and mixed input globally.
 *
 * Implementation:
 * Keep this class intentionally boring. Production integration contains no
 * gesture-specific controller branches.
 */
export class TouchController {
  /**
   * ARCHITECTURE SCAFFOLD:
   * Independent zoom/hover feature gates. Disabling either gate cancels only
   * an owner of that capability and resets all candidates; enabled recognizers
   * may continue observing while native Plotly remains the default.
   */
  private zoomEnabled = true;
  private hoverEnabled = false;

  /**
   * ARCHITECTURE SCAFFOLD:
   * Guards idempotent listener registration on the stable card root. This is
   * lifecycle state only and must not become gesture state.
   */
  private connected = false;

  /**
   * ARCHITECTURE SCAFFOLD:
   * The sole custom owner. `undefined` is the meaningful native/default state;
   * never install a synthetic owner representing Plotly.
   */
  private owner?: TouchSession;

  /**
   * ARCHITECTURE SCAFFOLD:
   * Fixed recognition priority. Pinch observes first so a definitive second
   * same-surface contact can claim before one-contact candidate logic. This is
   * an explicit list, not an extensible gesture plugin registry.
   */
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

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Preserve the existing card's enable/disable control shape without exposing
   * internal ownership.
   *
   * Responsibility:
   * Disable recognition immediately and cancel/reset custom state exactly once.
   *
   * Interactions:
   * `PlotlyGraph.setConfig` sets this from `disable_pinch_to_zoom`.
   *
   * Owns:
   * Controller enablement only.
   *
   * Must not:
   * Disable native Plotly touch behavior or mutate adapter internals.
   *
   * Implementation:
   * The existing configuration naming is retained. This gate controls custom
   * zoom only; long-press hover has its independent `touchHoverEnabled` gate.
   */
  get isEnabled(): boolean {
    return this.zoomEnabled;
  }

  set isEnabled(value: boolean) {
    if (this.zoomEnabled === value) return;
    this.zoomEnabled = value;
    if (!value && this.owner?.changesViewport) this.cancelOwner();
    this.resetRecognizers();
  }

  /** Enable long-press hover independently from custom zoom recognition. */
  get touchHoverEnabled(): boolean {
    return this.hoverEnabled;
  }

  set touchHoverEnabled(value: boolean) {
    if (this.hoverEnabled === value) return;
    this.hoverEnabled = value;
    if (!value) {
      if (this.owner && !this.owner.changesViewport) this.cancelOwner();
      this.options.plotly.clearHover();
    }
    this.resetRecognizers();
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Attach capture listeners to the stable Plotly root exactly once.
   *
   * Responsibility:
   * Observe starts/moves/ends/cancels before Plotly's target/document handlers
   * while leaving all unclaimed events untouched.
   *
   * Interactions:
   * Called from the card's connected lifecycle.
   *
   * Owns:
   * Root listener registration only.
   *
   * Must not:
   * Claim, prevent, or stop an event merely by connecting.
   *
   * Implementation:
   * Keep root capture ordering because delayed takeover depends on observing
   * threshold/second-contact events before Plotly's document/target listeners.
   */
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

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Detach all root listeners and discard local custom state safely.
   *
   * Responsibility:
   * Balance `connect`, cancel an owner, reset candidates, and leave no card
   * lifecycle pause active.
   *
   * Interactions:
   * Called from the card's disconnected lifecycle.
   *
   * Owns:
   * Controller-local teardown only.
   *
   * Must not:
   * Purge Plotly, synthesize touch completion, or touch foreign documents.
   *
   * Implementation:
   * Session cancellation handles its own local adapter resources; bounded real
   * touchcancel cleanup remains an event-driven session responsibility.
   */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const type of touchEvents) {
      this.options.root.removeEventListener(type, this.onTouchEvent, true);
    }
    this.cancelOwner();
    this.resetRecognizers();
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Route one root event according to the single-owner invariant.
   *
   * Responsibility:
   * Offer events to recognizers only while unowned, accept only the first
   * claim, reset all recognizers, and deliver the recognition event once to the
   * new owner. While owned, bypass recognizers completely.
   *
   * Interactions:
   * Bound to all four touch event types by `connect`.
   *
   * Owns:
   * Routing only; recognizers make claims and sessions decide suppression.
   *
   * Must not:
   * Prevent default, stop propagation, infer gesture type, or query Plotly.
   *
   * Future implementation:
   * This routing should remain unchanged as gesture logic is implemented.
   */
  private readonly onTouchEvent = (event: TouchEvent): void => {
    if (this.hoverEnabled) {
      if (event.type === "touchstart" && event.touches.length === 1) {
        this.options.plotly.clearHover();
      }
      if (
        event.isTrusted &&
        (event.type === "touchend" || event.type === "touchcancel") &&
        event.touches.length === 0
      ) {
        this.options.plotly.preserveHoverThroughNativeTouchEnd(
          Boolean(this.owner && !this.owner.changesViewport),
        );
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

  /**
   * Accept the first synchronous or timer-driven recognizer claim.
   *
   * JavaScript task serialization makes owner installation atomic. Recognizer
   * reset is the stale-capability boundary: timer-based recognizers must clear
   * and invalidate their own callbacks during this reset.
   */
  private readonly claim: ClaimTouch = (session) => {
    if ((!this.zoomEnabled && !this.hoverEnabled) || this.owner) return false;
    this.owner = session;
    this.resetRecognizers();
    if (session.changesViewport) this.options.onGestureStart();
    return true;
  };

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Apply an owner's explicit lifecycle decision.
   *
   * Responsibility:
   * Preserve ownership, end it with balanced callbacks, or replace the owner
   * directly without waking recognizers or emitting a false end/start pair.
   *
   * Interactions:
   * Called after every session event, including the recognition event.
   *
   * Owns:
   * Owner assignment and high-level lifecycle balancing only.
   *
   * Must not:
   * Interpret why a session ended/transferred or call adapter operations.
   *
   * Future implementation:
   * `DragZoomSession` returns `PinchSession` directly; recognizers remain reset
   * and dormant throughout uninterrupted custom ownership.
   */
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
    this.resetRecognizers();
    if (changedViewport) this.options.onGestureEnd();
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Cancel the sole custom owner during controller-level teardown.
   *
   * Responsibility:
   * Invoke session cleanup once, clear ownership, and balance the card callback.
   *
   * Interactions:
   * Used only by disable/disconnect, not normal touch completion.
   *
   * Owns:
   * Controller-level cancellation sequencing.
   *
   * Must not:
   * Manufacture a TouchEvent or perform Plotly cancellation work itself.
   *
   * Future implementation:
   * Keep cancellation idempotent even when a session has partially drained.
   */
  private cancelOwner(): void {
    if (!this.owner) return;
    const owner = this.owner;
    this.owner = undefined;
    owner.cancel();
    if (owner.changesViewport) this.options.onGestureEnd();
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Return every recognizer to an independent no-candidate state.
   *
   * Responsibility:
   * Centralize reset on claim, end, disable, and disconnect.
   *
   * Interactions:
   * Calls only recognizer-local cleanup; recognizers release their own opaque
   * adapter observation handles.
   *
   * Owns:
   * Iteration only.
   *
   * Must not:
   * Reset or cancel the active session.
   *
   * Future implementation:
   * Remain unconditional so no candidate leaks across ownership boundaries.
   */
  private resetRecognizers(): void {
    for (const { recognizer } of this.recognizers) recognizer.reset();
  }
}
