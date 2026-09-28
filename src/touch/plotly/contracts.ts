import type { ClientPoint } from "../geometry";

declare const plotlyTouchSurfaceBrand: unique symbol;
declare const nativeGestureObservationBrand: unique symbol;

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Identify the exact eligible Cartesian Plotly dragger touched by a contact.
 *
 * Responsibility:
 * Act as an opaque, stable session identity for subplot-specific operations.
 * Only the Plotly adapter may create or inspect this value.
 *
 * Interactions:
 * Recognizers compare identities and sessions retain one. Callers pass the
 * identity back to the adapter for zoom and lifecycle operations.
 *
 * Owns:
 * Identity only; it exposes no DOM or Plotly-private representation.
 *
 * Must not:
 * Reveal `.nsewdrag.drag`, `data-subplot`, graph-div state, axis objects, or
 * selector mechanics outside the adapter.
 *
 * Implementation:
 * Wrap the actual touched `.nsewdrag.drag`. Research established that a
 * touch's original target remains stable as it moves outside the subplot.
 */
export interface PlotlyTouchSurface {
  readonly [plotlyTouchSurfaceBrand]: true;
}

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Represent one caller's lease on adapter-owned observation state for a
 * Plotly-native touch gesture that may later be handed to a custom session.
 *
 * Responsibility:
 * Keep raw `plotly_relayouting` data and Plotly-private bookkeeping inside the
 * adapter while giving each recognizer a stable semantic lease.
 *
 * Interactions:
 * Created by `acquireNativeObservation`, used for takeover or cleanup through
 * the same adapter, transferred unchanged to a winning session, and released
 * by `releaseNativeObservation`.
 *
 * Owns:
 * Lease identity only. Multiple leases may share one canonical adapter-owned
 * record without exposing its reference count or listener.
 *
 * Must not:
 * Expose mutable Plotly event payloads or private graph-div fields.
 *
 * Implementation:
 * The adapter canonicalizes records by touched surface and first contact ID.
 * It retains one cloned latest native relayout update and one listener for all
 * leases on that physical sequence.
 */
export interface NativeGestureObservation {
  readonly [nativeGestureObservationBrand]: true;
}

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Define the sole Plotly-specific boundary used by the new touch subsystem.
 *
 * Responsibility:
 * Present semantic surface, native-lifecycle, zoom, and bounded
 * cancellation operations while containing every Plotly 4.1.1 workaround.
 *
 * Interactions:
 * Recognizers call observation and takeover operations. Sessions call zoom
 * and cancellation operations. `TouchController` only passes this contract to
 * recognizers and never inspects Plotly state itself.
 *
 * Owns:
 * Plotly-specific DOM resolution, private-state interpretation, captured
 * relayout snapshots, synthetic compatibility events, and finalization.
 *
 * Must not:
 * Become a global interaction manager, enumerate foreign Plotly instances,
 * monkey-patch document listeners, or expose private mechanics to callers.
 * General mixed mouse/touch isolation is explicitly out of scope.
 *
 * Implementation:
 * Implement only the experimentally supported Plotly 4.1.1 seams documented
 * on each operation below.
 */
export interface PlotlyTouchAdapterContract {
  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Resolve an observed contact to its eligible Cartesian Plotly surface.
   *
   * Responsibility:
   * Preserve the actual touched `.nsewdrag.drag` so subplot routing remains
   * exact and stable for the gesture lifetime.
   *
   * Interactions:
   * Called by unowned recognizers and by an owning session validating a direct
   * transfer. The returned identity is treated as opaque everywhere else.
   *
   * Owns:
   * DOM traversal and Plotly surface eligibility rules.
   *
   * Must not:
   * Fall back to the first dragger or expose the resolved DOM node.
   *
   * Implementation:
   * Resolve from `Touch.target`, whose identity remained tied to the original
   * dragger in browser probes even after the contact moved outside it.
   */
  resolveSurface(touch: Touch): PlotlyTouchSurface | undefined;

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Acquire a lease on adapter-side observation while Plotly remains native
   * owner.
   *
   * Responsibility:
   * Associate the first contact and surface with only the state needed for a
   * possible later custom takeover, reusing the canonical sequence record.
   *
   * Interactions:
   * Called independently by unowned recognizers after an eligible native
   * start. Each opaque lease is later used for takeover, transferred, or released
   * through this adapter.
   *
   * Owns:
   * Canonical records, lease bookkeeping, one Plotly listener per record, and
   * cloned native relayout updates.
   *
   * Must not:
   * Suppress the observed event or imply custom ownership.
   *
   * Implementation:
   * Acquisitions for the same `(surface, firstTouchIdentifier)` share one
   * underlying listener/snapshot. Clone Plotly-owned data before retaining it.
   */
  acquireNativeObservation(
    surface: PlotlyTouchSurface,
    firstTouchIdentifier: number,
  ): NativeGestureObservation;

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Transfer the currently observed native gesture into custom ownership.
   *
   * Responsibility:
   * Atomically reject an inactive observation, neutralize an active gesture
   * before movement, or commit and normalize an already-applied native pan.
   *
   * Interactions:
   * Called by a recognizer only after its gesture classification succeeds.
   * A `false` result means native Plotly is no longer active and no claim is
   * made; a `true` result means the returned custom session may take ownership.
   *
   * Owns:
   * Plotly-private state classification and both takeover mechanics.
   *
   * Must not:
   * Expose whether `_dragdata` exists, raw relayout payloads, zero-wheel
   * normalization, or layout/fullLayout mechanics to callers.
   *
   * Implementation:
   * Pre-pan takeover applies the researched inactive-state/click-train reset.
   * Post-pan takeover uses the validated targeted composite: cloned native
   * relayout update, drag neutralization, click reset, touched-surface zero
   * wheel, and immediate public relayout.
   */
  takeOverNativeGesture(observation: NativeGestureObservation): boolean;

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Apply a custom gesture's incremental zoom through Plotly's own surface.
   *
   * Responsibility:
   * Preserve subplot selection, linked/matched axes, constraints, and normal
   * wheel semantics while accepting only semantic caller input.
   *
   * Interactions:
   * Called exclusively by an owning session with its retained surface and
   * fixed anchor.
   *
   * Owns:
   * Synthetic wheel construction and dispatch details.
   *
   * Must not:
   * Re-resolve to a generic first dragger or expose wheel mechanics upward.
   *
   * Implementation:
   * Dispatch the established synthetic wheel form to the actual retained
   * touched dragger.
   */
  zoom(surface: PlotlyTouchSurface, anchor: ClientPoint, delta: number): void;

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Clean Plotly's native document handlers after an owned/intercepted touch
   * sequence is cancelled with no physical contacts remaining.
   *
   * Responsibility:
   * Perform only the bounded zero-contact cleanup supported by browser probes.
   *
   * Interactions:
   * Called synchronously by the owning session while handling a trusted real
   * `touchcancel` whose `touches.length` is zero.
   *
   * Owns:
   * The Plotly 4.1.1 completion workaround and its private state cleanup.
   *
   * Must not:
   * Generalize to cancellation with remaining contacts, run later in another
   * task, or coordinate with foreign graphs.
   *
   * Implementation:
   * The current least-bad seam marks native handling inactive, resets the
   * click train, and synchronously dispatches bounded synthetic completion
   * from the retained dragger. No reachable targeted teardown exists in 4.1.1.
   */
  cleanupCancelledGesture(
    observation: NativeGestureObservation,
    event: TouchEvent,
  ): void;

  /**
   * ARCHITECTURE SCAFFOLD:
   *
   * Purpose:
   * Release one lease after normal completion or custom lifecycle cleanup.
   *
   * Responsibility:
   * Pair every successful `acquireNativeObservation` with an explicit release.
   * Tear down captured state and listeners only after the final lease ends.
   *
   * Interactions:
   * Called by the recognizer/session that owns the opaque lease once no later
   * takeover decision can use it. Session transfer passes the same lease and
   * does not release/reacquire it.
   *
   * Owns:
   * Adapter-local lease accounting and final observation disposal only.
   *
   * Must not:
   * Complete or cancel a live physical gesture as a side effect.
   *
   * Implementation:
   * Releasing one of several leases preserves the canonical record. Final
   * release removes its listener and cloned update exactly once.
   */
  releaseNativeObservation(observation: NativeGestureObservation): void;
}
