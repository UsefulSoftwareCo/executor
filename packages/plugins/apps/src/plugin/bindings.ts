import { Effect } from "effect";
import { Data } from "effect";

import type { HandleBridge, HandleRootSpec } from "../seams/tool-sandbox";
import { ToolSandboxError } from "../seams/tool-sandbox";
import type { ScopeDbHandle } from "../seams/scope-db";
import type { ConnectionDecl } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// Connection DI: declare-then-bind. A tool's descriptor declares `connections`
// (role -> integration); before execution each role is bound to the user's
// connection(s) explicitly. A missing binding is a typed error naming role +
// surface (no auto-pick). The handler receives pre-bound clients whose method
// calls route through the platform invoke path.
//
// The routing is a seam: `ClientResolver` turns a (integration, connection,
// method path, args) into a JSON result. The self-hosted resolver calls the
// integration's real API through the connection credential (policy/audit
// applies there); a test resolver returns canned data. `db` is bound to the
// invoking scope's ScopeDb. Everything crossing is JSON (the cloud resolver is
// an RPC).
// ---------------------------------------------------------------------------

export class BindingError extends Data.TaggedError("BindingError")<{
  readonly message: string;
  readonly role: string;
  readonly surface: string;
}> {}

/** One bound connection for a role. Fan-out roles bind an ordered set. */
export type RoleBinding =
  | { readonly kind: "single"; readonly connection: string }
  | { readonly kind: "array"; readonly connections: readonly string[] };

/** The user's bindings for a tool invocation: role -> bound connection(s). */
export type Bindings = Readonly<Record<string, RoleBinding>>;

/** Resolves a single method call against a bound connection to a JSON result.
 *  This is where the platform invoke path (credentials, policy, audit) lives. */
export interface ClientResolver {
  readonly call: (input: {
    readonly integration: string;
    readonly connection: string;
    readonly path: readonly string[];
    readonly args: readonly unknown[];
  }) => Effect.Effect<unknown, BindingError>;
}

export interface BindingContext {
  /** Declared connection roles from the tool descriptor. */
  readonly declared: Readonly<Record<string, ConnectionDecl>>;
  /** The user's bindings (role -> connection[s]). Missing => typed error. */
  readonly bindings: Bindings;
  /** The invoking scope's app database (bound to the `db` root). */
  readonly db: ScopeDbHandle;
  /** Routes a bound method call to the real integration. */
  readonly resolver: ClientResolver;
}

/**
 * Validate bindings against declarations and compute the sandbox handle roots:
 * `db` is always a single root; each declared role becomes a single or array
 * root. Fails (typed) when a declared role has no binding, naming role +
 * surface — the "missing binding is a typed error" rule.
 */
export const rootsFor = (
  declared: Readonly<Record<string, ConnectionDecl>>,
  bindings: Bindings,
): Effect.Effect<Readonly<Record<string, HandleRootSpec>>, BindingError> =>
  Effect.gen(function* () {
    const roots: Record<string, HandleRootSpec> = { db: { kind: "single" } };
    for (const [role, decl] of Object.entries(declared)) {
      if (decl.kind === "catalog") {
        // Open-world proxy: parse + record, but execution is NotImplemented in
        // this build. Bind a single root; the resolver throws if called.
        roots[role] = { kind: "single" };
        continue;
      }
      const binding = bindings[role];
      if (!binding) {
        return yield* Effect.fail(
          new BindingError({
            message: `no connection bound for role "${role}" (surface "${decl.integration}")`,
            role,
            surface: decl.integration,
          }),
        );
      }
      if (decl.kind === "array") {
        if (binding.kind !== "array") {
          return yield* Effect.fail(
            new BindingError({
              message: `role "${role}" is a fan-out (connections("${decl.integration}")) and needs an array binding`,
              role,
              surface: decl.integration,
            }),
          );
        }
        roots[role] = { kind: "array", count: binding.connections.length };
      } else {
        if (binding.kind !== "single") {
          return yield* Effect.fail(
            new BindingError({
              message: `role "${role}" is a single connection and needs a single binding`,
              role,
              surface: decl.integration,
            }),
          );
        }
        roots[role] = { kind: "single" };
      }
    }
    return roots;
  });

// Parse a fan-out root name back into (role, index): `inboxes#1` -> {inboxes,1}.
const parseRoot = (root: string): { role: string; index?: number } => {
  const hash = root.indexOf("#");
  if (hash === -1) return { role: root };
  return { role: root.slice(0, hash), index: Number(root.slice(hash + 1)) };
};

/**
 * Build the HandleBridge the sandbox calls out through. `db` routes to the
 * scope database; a declared role routes to its bound connection through the
 * `ClientResolver`. Undeclared roots are unreachable (the sandbox never injects
 * them). A `.account` read on a client returns bound-connection metadata
 * without a round-trip.
 */
export const buildBridge = (context: BindingContext): HandleBridge => ({
  call: ({ root, path, args }) => {
    if (root === "db") {
      // The scope db handle exposes `sql` as a tagged template; the injected
      // client calls `db.sql(templateStrings, ...values)`. When routed through
      // the bridge, `path = ["sql"]` and args = [stringsArray, ...values].
      if (path.length === 1 && path[0] === "sql") {
        const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
        return context.db
          .sql(strings, ...values)
          .pipe(
            Effect.mapError(
              (cause) => new ToolSandboxError({ kind: "invoke", message: cause.message, cause }),
            ),
          );
      }
      return Effect.fail(
        new ToolSandboxError({ kind: "invoke", message: `unsupported db call: ${path.join(".")}` }),
      );
    }

    const { role, index } = parseRoot(root);
    const decl = context.declared[role];
    if (!decl) {
      return Effect.fail(
        new ToolSandboxError({ kind: "invoke", message: `undeclared handle root: ${root}` }),
      );
    }
    if (decl.kind === "catalog") {
      return Effect.fail(
        new ToolSandboxError({
          kind: "invoke",
          message: "catalog() open-world proxy execution is not implemented in this build",
        }),
      );
    }

    // A `.account` read returns bound-connection metadata (safe, no creds).
    const binding = context.bindings[role];
    const connectionName =
      binding?.kind === "array"
        ? binding.connections[index ?? 0]
        : binding?.kind === "single"
          ? binding.connection
          : undefined;
    if (!connectionName) {
      return Effect.fail(
        new ToolSandboxError({ kind: "invoke", message: `no binding for role ${role}` }),
      );
    }
    if (path.length === 1 && path[0] === "account") {
      // Clients read `.account.email` / `.account.login`; expose both keys.
      return Effect.succeed({ email: connectionName, login: connectionName, name: connectionName });
    }

    return context.resolver
      .call({ integration: decl.integration, connection: connectionName, path, args })
      .pipe(
        Effect.mapError(
          (cause) => new ToolSandboxError({ kind: "invoke", message: cause.message, cause }),
        ),
      );
  },
});
