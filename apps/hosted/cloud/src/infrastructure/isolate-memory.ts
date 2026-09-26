/**
 * Memory that lives as long as the isolate. Module scope is the isolate: every executor built
 * in it (the API, MCP sessions, schedules, workflows, provisioning and app pages) shares this
 * store, so `declarationLimits` bounds the whole isolate rather than each executor.
 */
import { makeDeclarationCache } from "@executor-js/sdk/core";

/** Evaluated declarations can carry credential-derived text; they never leave this isolate. */
export const isolateDeclarations = makeDeclarationCache();
