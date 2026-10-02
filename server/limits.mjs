// Target execution includes the workflow's own model calls and tool handoffs.
// Planner, evaluator, HTTP and PDF deadlines are separate limits.
export const MIN_TARGET_TIMEOUT_MS = 100;
export const MAX_TARGET_TIMEOUT_MS = 180_000;
export const DEFAULT_TARGET_TIMEOUT_MS = 5_000;
