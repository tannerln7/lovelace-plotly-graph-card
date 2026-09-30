import Plotly from "../../plotly";
import type { ClientPoint } from "../geometry";
import type {
  NativeGestureObservation,
  PlotlyTouchAdapterContract,
  PlotlyTouchSurface,
} from "./contracts";

type RelayoutListener = (update: Plotly.PlotRelayoutEvent) => void;

interface PlotlyFxApi {
  hover(
    root: Plotly.PlotlyHTMLElement,
    event: ClientPoint & {
      readonly target: Element;
      readonly hovermode: string;
    },
    subplot: string,
  ): void;
  unhover(root: Plotly.PlotlyHTMLElement): void;
}

interface HoverRequest {
  readonly surface: PlotlyTouchSurface;
  readonly point: ClientPoint;
}

const plotlyFx = (Plotly as unknown as { Fx: PlotlyFxApi }).Fx;

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Describe only the Plotly 4.1.1 graph-div fields needed to observe native
 * touch progress and manage the adapter's own event subscription.
 *
 * Responsibility:
 * Keep private Plotly field access localized and reviewable in this adapter.
 *
 * Interactions:
 * Read by the adapter's atomic takeover classification and relayout filtering.
 * The event methods register exactly one listener per canonical observation.
 *
 * Owns:
 * No state; this is an adapter-private view of the supplied graph root.
 *
 * Must not:
 * Escape through the public contract; all reads and researched lifecycle
 * mutations remain confined to this adapter.
 *
 * Implementation:
 * Keep version-specific fields here so future Plotly changes do not alter
 * recognizer/session contracts.
 */
interface ObservedPlotlyRoot extends Plotly.PlotlyHTMLElement {
  _dragging?: boolean;
  _dragged?: boolean;
  _dragdata?: { element?: Element };
  _mouseDownTime?: number;
  _fullLayout?: { hovermode?: string | false };
  removeListener(event: "plotly_relayouting", listener: RelayoutListener): void;
}

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Canonically observe one physical native Plotly touch sequence.
 *
 * Responsibility:
 * Share one listener and cloned relayout snapshot across all
 * recognizer/session leases for `(surface, firstTouchIdentifier)`.
 *
 * Interactions:
 * Leases point here indirectly through the adapter's private weak map. The
 * final lease release disposes this record and its listener.
 *
 * Owns:
 * Sequence identity, live leases, and the latest cloned native update.
 *
 * Must not:
 * Escape the adapter, suppress input, or mutate Plotly gesture state.
 */
interface NativeObservationRecord {
  readonly surface: PlotlyTouchSurface;
  readonly element: Element;
  readonly firstTouchIdentifier: number;
  leaseCount: number;
  listener: RelayoutListener;
  latestRelayoutUpdate?: Plotly.PlotRelayoutEvent;
}

const cloneRelayoutUpdate = (
  update: Plotly.PlotRelayoutEvent,
): Plotly.PlotRelayoutEvent =>
  JSON.parse(JSON.stringify(update)) as Plotly.PlotRelayoutEvent;

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Provide the concrete home for all Plotly 4.1.1 touch compatibility mechanics.
 *
 * Responsibility:
 * Implement `PlotlyTouchAdapterContract` against one card's stable Plotly root
 * without allowing DOM/private-state details into controller, recognizers, or
 * sessions.
 *
 * Interactions:
 * Constructed for one Plotly graph and passed to `TouchController`, which
 * injects it into recognizers. Owning sessions retain the same semantic
 * contract after a recognizer claims.
 *
 * Owns:
 * The graph root, opaque surface mappings, native observation records, Plotly event
 * listeners, private version-specific state access, and compatibility events.
 *
 * Must not:
 * Decide gesture recognition, own physical contacts, coordinate other graphs,
 * globally patch listeners, or attempt general mixed mouse/touch isolation.
 *
 * Implementation:
 * Keep browser-validated targeted-composite post-pan handoff, semantic wheel
 * routing, and bounded cancellation workarounds entirely in this class.
 */
export class PlotlyTouchAdapter implements PlotlyTouchAdapterContract {
  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Keep Plotly/DOM representations behind opaque public identities.
   *
   * Responsibility:
   * Canonicalize each dragger once and map caller leases to adapter-owned
   * sequence records without making either mapping observable to callers.
   *
   * Interactions:
   * Surface maps are populated by `resolveSurface`; observation maps are
   * populated by acquisition and drained by final release.
   *
   * Owns:
   * All surface, sequence, listener, snapshot, and lease bookkeeping.
   *
   * Must not:
   * Become controller-owned state or expose reference counts/DOM elements.
   */
  private readonly root: ObservedPlotlyRoot;
  private readonly surfaceByElement = new WeakMap<
    Element,
    PlotlyTouchSurface
  >();
  private readonly surfaces = new WeakMap<PlotlyTouchSurface, Element>();
  private readonly observations = new Map<
    PlotlyTouchSurface,
    Map<number, NativeObservationRecord>
  >();
  private readonly leases = new WeakMap<
    NativeGestureObservation,
    NativeObservationRecord | null
  >();

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Identify which canonical record may interpret graph-wide Plotly state.
   *
   * Responsibility:
   * Prevent a still-leased record from an older sequence from capturing a new
   * sequence's graph-wide `plotly_relayouting` events.
   *
   * Interactions:
   * Set on acquisition of a distinct current sequence and cleared only when
   * that record's final lease is released; older records are not reactivated.
   *
   * Owns:
   * Adapter-local attribution only, not physical or custom gesture ownership.
   *
   * Must not:
   * Coordinate across graphs or imply event suppression.
   */
  private activeObservation?: NativeObservationRecord;
  private latestCustomHover?: HoverRequest;

  constructor(root: Plotly.PlotlyHTMLElement) {
    this.root = root as ObservedPlotlyRoot;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Resolve one touch to an opaque eligible Cartesian surface.
   *
   * Responsibility:
   * Use the touch's actual original target and preserve subplot identity.
   *
   * Interactions:
   * Called by unowned recognizers and an owner considering session transfer.
   *
   * Owns:
   * DOM traversal and surface wrapper creation.
   *
   * Must not:
   * Return DOM elements or silently select the graph's first dragger.
   *
   * Implementation:
   * Resolve the associated `.nsewdrag.drag` within this adapter's root.
   */
  resolveSurface(touch: Touch): PlotlyTouchSurface | undefined {
    const target = touch.target as Element | null;
    if (!target || typeof target.closest !== "function") return undefined;

    const element = target.closest(".nsewdrag.drag");
    if (!element || !this.root.contains(element)) return undefined;

    const existing = this.surfaceByElement.get(element);
    if (existing) return existing;

    const surface = Object.freeze({}) as PlotlyTouchSurface;
    this.surfaceByElement.set(element, surface);
    this.surfaces.set(surface, element);
    return surface;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Acquire one lease on adapter-local observation for a native gesture.
   *
   * Responsibility:
   * Reuse one canonical contact/surface record and capture only
   * takeover-relevant native progress while Plotly remains the owner.
   *
   * Interactions:
   * Returns a distinct opaque lease used by later lifecycle operations.
   *
   * Owns:
   * Lease accounting plus one Plotly listener and snapshot per record.
   *
   * Must not:
   * Suppress input, claim the gesture, or return raw payloads.
   *
   * Implementation:
   * Clone the latest `plotly_relayouting` update needed by post-pan handoff.
   * Same-sequence acquisitions must not duplicate listener/snapshot state.
   */
  acquireNativeObservation(
    surface: PlotlyTouchSurface,
    firstTouchIdentifier: number,
  ): NativeGestureObservation {
    const element = this.getSurfaceElement(surface);

    let byIdentifier = this.observations.get(surface);
    if (!byIdentifier) {
      byIdentifier = new Map();
      this.observations.set(surface, byIdentifier);
    }

    let record = byIdentifier.get(firstTouchIdentifier);
    if (!record) {
      record = this.createObservation(surface, element, firstTouchIdentifier);
      byIdentifier.set(firstTouchIdentifier, record);
    }

    this.activeObservation = record;
    const observation = Object.freeze({}) as NativeGestureObservation;
    record.leaseCount += 1;
    this.leases.set(observation, record);
    return observation;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Transfer one active Plotly-native gesture into custom ownership.
   *
   * Responsibility:
   * Keep pre-pan neutralization and post-pan range finalization as one atomic
   * semantic operation so recognizers cannot choose or partially apply the
   * version-specific lifecycle mechanics.
   *
   * Interactions:
   * Called only after recognition succeeds. Returning false leaves the event
   * unclaimed because the observed native gesture is no longer active.
   *
   * Owns:
   * Private native-state classification, click reset, and every step of the
   * Plotly 4.1.1 targeted composite when pan has already applied.
   *
   * Must not:
   * Expose state labels, saved payloads, zero-wheel normalization, or drag
   * fields to recognizers.
   *
   * Implementation:
   * Before movement, mark native completion inactive and reset the click
   * train. After movement, use the cloned update, neutralization,
   * touched-surface zero wheel, and immediate public relayout validated by
   * browser research.
   */
  takeOverNativeGesture(observation: NativeGestureObservation): boolean {
    const record = this.getLiveRecord(observation);
    if (record !== this.activeObservation || !this.root._dragging) return false;

    const panApplied =
      this.root._dragged && this.root._dragdata?.element === record.element;
    if (!panApplied) {
      this.root._dragging = false;
      this.resetClickTrain();
      return true;
    }
    if (!record.latestRelayoutUpdate) {
      throw new Error("Native pan has no retained Plotly relayout update");
    }

    const update = cloneRelayoutUpdate(record.latestRelayoutUpdate);
    this.root._dragging = false;
    this.root._dragged = false;
    delete this.root._dragdata;
    this.resetClickTrain();

    const rect = record.element.getBoundingClientRect();
    this.dispatchWheel(
      record.element,
      {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      },
      0,
    );
    void Plotly.relayout(this.root, update);
    return true;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Translate session zoom intent through Plotly's native wheel seam.
   *
   * Responsibility:
   * Apply one signed incremental delta at a fixed anchor to the retained surface.
   *
   * Interactions:
   * Called by the sole owning session.
   *
   * Owns:
   * WheelEvent construction, sign convention, and target dispatch.
   *
   * Must not:
   * Choose a subplot or inspect gesture contacts.
   *
   * Implementation:
   * Dispatch the established synthetic wheel form to the wrapped actual dragger.
   */
  zoom(
    surface: PlotlyTouchSurface,
    anchor: { readonly clientX: number; readonly clientY: number },
    delta: number,
  ): void {
    this.dispatchWheel(this.getSurfaceElement(surface), anchor, -delta);
  }

  /**
   * Render custom touch hover through Plotly's own Fx pipeline. The adapter
   * supplies the exact dragger target/subplot and maps `closest` to `x`, which
   * makes touch hover useful without requiring the finger to hit a marker.
   */
  showHover(surface: PlotlyTouchSurface, point: ClientPoint): void {
    const request = {
      surface,
      point: { clientX: point.clientX, clientY: point.clientY },
    };
    this.latestCustomHover = request;
    this.renderHover(request);
  }

  /** Clear both rendered hover and Plotly's throttled pending hover callback. */
  clearHover(): void {
    this.latestCustomHover = undefined;
    if (this.root._fullLayout) plotlyFx.unhover(this.root);
  }

  /**
   * Let Plotly finish native click/double-click bookkeeping first, then remove
   * native tap hover before the next paint. Custom takeover makes Plotly's
   * touchend closure return early, so an existing custom hover needs no
   * unhover/re-render cycle. A microtask is too early in Shadow DOM because it
   * can run before Plotly's document-level touchend closure.
   */
  reconcileNativeTouchEnd(): void {
    if (this.latestCustomHover) return;

    const afterNativeCompletion = (): void => {
      // Never let deferred cleanup for an older native sequence erase a newer
      // custom hover.
      if (this.latestCustomHover) return;

      if (this.root._fullLayout) plotlyFx.unhover(this.root);
    };
    const view = this.root.ownerDocument.defaultView;
    if (view?.requestAnimationFrame)
      view.requestAnimationFrame(afterNativeCompletion);
    else setTimeout(afterNativeCompletion, 0);
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Remove Plotly's stale document handlers after qualifying cancellation.
   *
   * Responsibility:
   * Handle only trusted, synchronous, zero-remaining-contact touch cancellation.
   *
   * Interactions:
   * Called by an owner during the real cancel handler with a type-bounded request.
   *
   * Owns:
   * The version-specific synthetic completion workaround.
   *
   * Must not:
   * Run for remaining contacts, defer work, or arbitrate unrelated graphs.
   *
   * Implementation:
   * Revalidate zero contacts, neutralize/reset, and synchronously complete from
   * the original retained dragger as supported by probes G1/G2.
   */
  cleanupCancelledGesture(
    observation: NativeGestureObservation,
    event: TouchEvent,
  ): void {
    const record = this.getLiveRecord(observation);
    if (event.touches.length !== 0 || !event.isTrusted) {
      throw new Error(
        "Plotly cancellation cleanup requires a trusted zero-contact event",
      );
    }

    this.root._dragging = false;
    this.resetClickTrain();
    record.element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: [],
        targetTouches: [],
        changedTouches: [],
      }),
    );
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Release one caller's lease on adapter-local native observation.
   *
   * Responsibility:
   * Preserve shared resources while leases remain, then remove the matching
   * listener and cloned data exactly once on final release.
   *
   * Interactions:
   * Called by the recognizer or session currently responsible for the lease.
   *
   * Owns:
   * Lease accounting and final observation resource teardown only.
   *
   * Must not:
   * Complete a physical gesture or mutate ranges as a teardown side effect.
   *
   * Implementation:
   * Session transfer keeps the same lease. Make final disposal safe after
   * normal completion, takeover, and owner cleanup.
   */
  releaseNativeObservation(observation: NativeGestureObservation): void {
    const record = this.leases.get(observation);
    if (record === undefined) {
      throw new Error(
        "Native observation lease does not belong to this adapter",
      );
    }
    if (record === null) return;

    this.leases.set(observation, null);
    record.leaseCount -= 1;
    if (record.leaseCount > 0) return;

    this.root.removeListener("plotly_relayouting", record.listener);
    record.latestRelayoutUpdate = undefined;

    const byIdentifier = this.observations.get(record.surface);
    byIdentifier?.delete(record.firstTouchIdentifier);
    if (byIdentifier?.size === 0) this.observations.delete(record.surface);
    if (this.activeObservation === record) this.activeObservation = undefined;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Create the one adapter-owned record for a native sequence.
   *
   * Responsibility:
   * Register one graph listener and retain only relayout updates attributable
   * to this currently active surface/sequence.
   *
   * Interactions:
   * Called on the first acquisition for a canonical key. The listener checks
   * graph-global Plotly state because relayout events carry no touch identity.
   *
   * Owns:
   * Listener creation and immediate cloning of Plotly-owned updates.
   *
   * Must not:
   * Capture non-native or another surface's relayout, mutate Plotly, or expose
   * the saved payload outside the adapter.
   */
  private createObservation(
    surface: PlotlyTouchSurface,
    element: Element,
    firstTouchIdentifier: number,
  ): NativeObservationRecord {
    const record: NativeObservationRecord = {
      surface,
      element,
      firstTouchIdentifier,
      leaseCount: 0,
      listener: () => undefined,
    };
    record.listener = (update) => {
      if (
        this.activeObservation !== record ||
        !this.root._dragging ||
        !this.root._dragged ||
        this.root._dragdata?.element !== element
      ) {
        return;
      }
      record.latestRelayoutUpdate = cloneRelayoutUpdate(update);
    };
    this.root.on("plotly_relayouting", record.listener);
    return record;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Resolve an opaque lease to its live canonical record.
   *
   * Responsibility:
   * Reject foreign or released leases before any semantic
   * lifecycle operation reads adapter-owned state.
   *
   * Interactions:
   * Shared by takeover, cancellation cleanup, and lease validation.
   *
   * Owns:
   * Adapter-local validation only.
   *
   * Must not:
   * Expose the record or its private state to callers.
   */
  private getLiveRecord(
    observation: NativeGestureObservation,
  ): NativeObservationRecord {
    const record = this.leases.get(observation);
    if (!record) {
      throw new Error("Native observation lease is not active in this adapter");
    }
    return record;
  }

  /**
   * ARCHITECTURE SCAFFOLD:
   * Keep the researched click-train reset and synthetic wheel convention
   * private so takeover callers cannot perform only half of a lifecycle step.
   */
  private resetClickTrain(): void {
    this.root._mouseDownTime = 0;
  }

  private getSurfaceElement(surface: PlotlyTouchSurface): Element {
    const element = this.surfaces.get(surface);
    if (!element) {
      throw new Error("Plotly touch surface does not belong to this adapter");
    }
    return element;
  }

  private renderHover(request: HoverRequest): void {
    const element = this.getSurfaceElement(request.surface);
    const configuredMode = this.root._fullLayout?.hovermode;
    const hovermode =
      configuredMode && configuredMode !== "closest" ? configuredMode : "x";
    plotlyFx.hover(
      this.root,
      { ...request.point, target: element, hovermode },
      element.getAttribute("data-subplot") || "xy",
    );
  }

  private dispatchWheel(
    element: Element,
    anchor: { readonly clientX: number; readonly clientY: number },
    deltaY: number,
  ): void {
    element.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: anchor.clientX,
        clientY: anchor.clientY,
        deltaX: 0,
        deltaY,
      }),
    );
  }
}
