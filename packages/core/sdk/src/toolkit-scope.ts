// ---------------------------------------------------------------------------
// Toolkit scope — wraps an Executor so the MCP surface only sees, and can only
// run, a toolkit's slice of connections. Toolkit-agnostic: it operates on a
// plain ResolvedToolkitScope (produced by the toolkits plugin's `resolveScope`)
// and the base Executor. Because the wrapped Executor is handed to the engine
// before construction, EVERY surface (tools.list, search, describe,
// sources/connections/integrations.list, core-tools, and execute) flows through
// it — enforcement is at execute, not just listing, so guessed out-of-slice
// addresses are blocked too.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { ToolBlockedError } from "./errors";
import type { Executor } from "./executor";
import type { ToolAddress } from "./ids";
import type { AnyPlugin } from "./plugin";
import type { StorageFailure } from "./fuma-runtime";

export type ToolkitAccess = "off" | "read" | "full";

export type ToolkitPolicyAction = "approve" | "require_approval" | "block";

export interface ToolkitPolicyRule {
  /** Glob over `<integration>.<connection>.<tool>` — `*` matches one segment,
   *  a trailing `*` matches the rest, and `*` inside a segment globs. */
  readonly pattern: string;
  readonly action: ToolkitPolicyAction;
}

export interface ToolkitScopeEntry {
  readonly integration: string;
  /** A pinned connection name, or "*" to track every connection of the integration. */
  readonly connection: string;
  readonly access: ToolkitAccess;
}

export interface ResolvedToolkitScope {
  readonly entries: readonly ToolkitScopeEntry[];
  /** Per-toolkit policy rules. v1 enforces `block` (exclusion); `approve` /
   *  `require_approval` are carried for the briefing — org-level approval
   *  policies are still enforced by the base executor when inherited. */
  readonly policies: readonly ToolkitPolicyRule[];
  readonly inheritOrgPolicies: boolean;
}

/** Empty slice — exposes no connection tools (static/core tools stay visible).
 *  Applied fail-closed when a selector resolves to no toolkit (unknown or
 *  not visible to the caller), so a bad selector never leaks the full account. */
export const EMPTY_TOOLKIT_SCOPE: ResolvedToolkitScope = {
  entries: [],
  policies: [],
  inheritOrgPolicies: true,
};

/** Glob match over dot segments: `*` matches one segment, a trailing bare `*`
 *  matches the rest, and `*` inside a segment globs within it. */
const matchPattern = (pattern: string, target: string): boolean => {
  const p = pattern.toLowerCase().trim().split(".");
  const a = target.toLowerCase().split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" && i === p.length - 1) return true;
    if (a[i] === undefined) return false;
    const re = new RegExp(
      "^" + p[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    if (!re.test(a[i])) return false;
  }
  return p.length === a.length;
};

/** A plugin extension capable of resolving a selector (slug or id) to a scope,
 *  scoped to the caller. `resolveScope` returns null when nothing matches. */
export interface ToolkitResolver {
  readonly resolveScope: (
    selector: string,
  ) => Effect.Effect<ResolvedToolkitScope | null, StorageFailure>;
}

const accessFor = (
  scope: ResolvedToolkitScope,
  integration: string,
  connection: string,
): ToolkitAccess => {
  for (const e of scope.entries) {
    if (e.integration === integration && e.connection === connection) return e.access;
  }
  for (const e of scope.entries) {
    if (e.integration === integration && e.connection === "*") return e.access;
  }
  return "off";
};

/** Wrap `base` so only the toolkit's slice is visible/runnable. Reads the full
 *  catalog once to compute the set of allowed tool addresses (applying
 *  off/read/full + the read-only classification), then narrows every surface. */
export const applyToolkitScope = <TPlugins extends readonly AnyPlugin[]>(
  base: Executor<TPlugins>,
  scope: ResolvedToolkitScope,
): Effect.Effect<Executor<TPlugins>, StorageFailure> =>
  Effect.gen(function* () {
    const blockRules = scope.policies.filter((p) => p.action === "block");
    const isBlocked = (integration: string, connection: string, name: string) =>
      blockRules.some((p) => matchPattern(p.pattern, `${integration}.${connection}.${name}`));

    const all = yield* base.tools.list();
    const allowed = new Set<string>();
    for (const t of all) {
      // Static/core tools stay visible — their RESULTS still flow through the
      // wrapped executor below (so connections/integrations lists are narrowed).
      if (t.static === true) {
        allowed.add(String(t.address));
        continue;
      }
      if (isBlocked(String(t.integration), String(t.connection), String(t.name))) continue;
      const a = accessFor(scope, String(t.integration), String(t.connection));
      if (a === "full" || (a === "read" && t.annotations?.readOnly === true)) {
        allowed.add(String(t.address));
      }
    }
    const allowedIntegrations = new Set(
      scope.entries.filter((e) => e.access !== "off").map((e) => e.integration),
    );
    const connOk = (integration: string, connection: string) =>
      accessFor(scope, integration, connection) !== "off";
    const addrOk = (address: ToolAddress) => allowed.has(String(address));

    return {
      ...base,
      integrations: {
        ...base.integrations,
        list: () =>
          base.integrations
            .list()
            .pipe(Effect.map((xs) => xs.filter((i) => allowedIntegrations.has(String(i.slug))))),
        get: (slug) =>
          allowedIntegrations.has(String(slug))
            ? base.integrations.get(slug)
            : Effect.succeed(null),
      },
      connections: {
        ...base.connections,
        list: (filter) =>
          base.connections
            .list(filter)
            .pipe(
              Effect.map((xs) => xs.filter((c) => connOk(String(c.integration), String(c.name)))),
            ),
        get: (ref) =>
          base.connections
            .get(ref)
            .pipe(
              Effect.map((c) => (c && connOk(String(c.integration), String(c.name)) ? c : null)),
            ),
      },
      tools: {
        ...base.tools,
        list: (filter) =>
          base.tools.list(filter).pipe(Effect.map((xs) => xs.filter((t) => addrOk(t.address)))),
        schema: (address) => (addrOk(address) ? base.tools.schema(address) : Effect.succeed(null)),
      },
      execute: (address, args, options) =>
        addrOk(address)
          ? base.execute(address, args, options)
          : Effect.fail(new ToolBlockedError({ address, pattern: "toolkit" })),
    } as Executor<TPlugins>;
  });
