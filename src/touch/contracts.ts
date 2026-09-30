import type { ClientPoint } from "./geometry";
import type {
  PlotlyTouchAdapterContract,
  PlotlyTouchSurface,
} from "./plotly/contracts";

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Preserve stable identity and immutable start data for one eligible contact.
 *
 * Responsibility:
 * Decouple sessions from TouchList ordering and live browser Touch objects.
 *
 * Interactions:
 * Recognizers construct contact snapshots after resolving a Plotly surface;
 * sessions index them by `identifier` and retain their surface/start.
 *
 * Owns:
 * Per-contact identity and initial data only.
 *
 * Must not:
 * Store array position as identity, expose Plotly internals, or imply gesture
 * ownership merely because a contact was observed.
 *
 * Future implementation:
 * Update current coordinates separately while preserving `identifier`,
 * `surface` and `start` for the full owned sequence.
 */
export interface TouchContactIdentity {
  readonly identifier: number;
  readonly surface: PlotlyTouchSurface;
  readonly start: ClientPoint;
}

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Express the complete outcome of one event delivered to the current owner.
 *
 * Responsibility:
 * Distinguish continued ownership (`undefined`), clean end (`null`), and a
 * direct replacement session without a false global end/start lifecycle.
 *
 * Interactions:
 * Returned by `TouchSession.handle` and interpreted only by `TouchController`.
 *
 * Owns:
 * A compact lifecycle decision and, for transfer, the replacement owner.
 *
 * Must not:
 * Encode Plotly state, recognizer identity, or event-suppression policy.
 *
 * Future implementation:
 * A drag-zoom session returns a pinch session when another valid same-surface
 * contact arrives; high-level card callbacks remain active.
 */
export type TouchSessionResult = TouchSession | null | undefined;

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Represent the sole custom owner after recognition succeeds.
 *
 * Responsibility:
 * Exclusively process the claimed physical sequence, suppress owned browser
 * events where required, request semantic adapter operations, and report its
 * lifecycle result.
 *
 * Interactions:
 * Created by a recognizer or predecessor session and routed by
 * `TouchController`. Sessions may call the Plotly adapter but never invoke
 * recognizers or manipulate controller state directly.
 *
 * Owns:
 * Gesture-specific contact tracking, fixed anchors, incremental deltas, drain
 * state, and event suppression after claim.
 *
 * Must not:
 * Read Plotly private fields, construct synthetic wheel events, or release
 * ownership merely because one contact of an owned multi-touch sequence ends.
 *
 * Future implementation:
 * Handle the recognition event once immediately after claim, then remain owner
 * until end/cancel or transfer directly to another session.
 */
export interface TouchSession {
  /** Whether this ownership changes the visible Plotly viewport. */
  readonly changesViewport: boolean;
  handle(event: TouchEvent): TouchSessionResult;
  cancel(): void;
}

/**
 * Install a recognized session as the sole custom owner.
 *
 * The controller supplies this capability to recognizers. It may be invoked
 * during `handle` or retained by a recognizer whose decision depends on its
 * own timer. `false` means ownership is no longer available or recognition is
 * disabled.
 */
export type ClaimTouch = (session: TouchSession) => boolean;

/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Observe native/unowned touch events and claim only a positively recognized
 * custom gesture.
 *
 * Responsibility:
 * Retain only candidate state, avoid suppressing observational events, and
 * request ownership with a fully initialized session when recognition becomes
 * definitive.
 *
 * Interactions:
 * Called in controller-defined priority order only while there is no owner.
 * On an accepted synchronous claim, all recognizers reset and the new session
 * receives the same recognition event exactly once. A recognizer may retain
 * `claim` for a locally timed decision; no event is fabricated in that case.
 *
 * Owns:
 * Candidate recognition state only.
 *
 * Must not:
 * Continue observing after a claim, own a gesture itself, suppress merely
 * because it is watching, or manipulate Plotly-private state.
 *
 * Future implementation:
 * Use the semantic adapter to resolve surfaces and request atomic native
 * takeover immediately before requesting ownership. `reset()` must invalidate
 * every retained claim callback and release untransferred resources.
 */
export interface TouchRecognizer {
  handle(event: TouchEvent, claim: ClaimTouch): void;
  reset(): void;
}
