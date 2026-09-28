/**
 * ARCHITECTURE SCAFFOLD:
 *
 * Purpose:
 * Define the public module boundary of the new touch subsystem.
 *
 * Responsibility:
 * Export only controller construction and the concrete Plotly adapter used by
 * card integration without involving legacy code.
 *
 * Interactions:
 * `PlotlyGraph` imports from this entry point and supplies its stable Plotly
 * root plus existing render lifecycle callbacks.
 *
 * Owns:
 * Exports only.
 *
 * Must not:
 * Instantiate global state, register listeners, export legacy implementation,
 * or expose Plotly-private compatibility types.
 *
 * Implementation:
 * Keep this production surface intentional; Scan is not part of the
 * foundational exports.
 */
export { TouchController } from "./controller";
export type { TouchControllerOptions } from "./controller";
export { PlotlyTouchAdapter } from "./plotly/adapter";
