/**
 * Types for `check-bundle-budget.mjs`.
 *
 * The script is plain ESM on purpose — it runs from `npm run check:bundle` in
 * CI with no build step in front of it, and a `.ts` gate that has to be
 * compiled before it can guard the build is a gate with a build of its own.
 * This declaration is what lets the test import it under `strict`.
 */

export const ROUTE_BUDGET_BYTES: number;
export const SHARED_BUDGET_BYTES: number;

export interface RouteSize {
  readonly route: string;
  readonly bytes: number;
}

export interface Measurement {
  readonly routes: readonly RouteSize[];
  readonly sharedBytes: number;
}

export function sharedFilesOf(routeFiles: Record<string, string[]>): string[];
export function measure(buildDir: string): Promise<Measurement>;
export function violationsOf(measurement: Measurement): string[];
