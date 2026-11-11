/**
 * Standard SDK contract combining knowledge and local workflows.
 * Core-only consumers use WikiCore without requiring the workflow engine.
 */
export type * from "./compiler-composition.js";
import type { WikiCore } from "./compiler-composition.js";

export interface Wiki extends WikiCore {}
