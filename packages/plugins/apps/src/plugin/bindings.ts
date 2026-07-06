import { Effect } from "effect";
import { Data } from "effect";

import type { HandleBridge, HandleRootSpec } from "../seams/tool-sandbox";
import { ToolSandboxError } from "../seams/tool-sandbox";
import type { ScopeDbHandle } from "../seams/scope-db";
import type { IntegrationDecl } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// Integration DI: declare in source, choose at invocation.
//
// A tool descriptor declares `integrations` (role -> integration slug). The
// caller supplies one connection address per role in the tool-call payload, and
// this layer peels those role properties off before the handler runs. If an org
// has exactly one connection for a role's integration, that connection is used
// as the default. Missing, unknown, or wrong-integration choices are typed
// BindingError failures. The handler receives clients under the declared role
// names and `db`.
// ---------------------------------------------------------------------------

export class BindingError extends Data.TaggedError("BindingError")<{
  readonly message: string;
  readonly role: string;
  readonly integration: string;
  readonly requestedConnection?: string;
}> {}

export interface ConnectionCandidate {
  readonly address: string;
  readonly integration: string;
  readonly name?: string;
  readonly owner?: string;
}

/** The resolved connections for a tool invocation: role -> connection address. */
export type RoleBindings = Readonly<Record<string, string>>;

/** Resolves connection inventory and method calls for declared integration
 *  roles. Host wiring will back this with core connection lookup and normal
 *  policy/credential invocation. */
export interface ClientResolver {
  readonly listConnections: (input: {
    readonly integration: string;
  }) => Effect.Effect<readonly ConnectionCandidate[], BindingError>;
  readonly resolveConnection: (input: {
    readonly connection: string;
  }) => Effect.Effect<ConnectionCandidate | null, BindingError>;
  readonly call: (input: {
    readonly integration: string;
    readonly connection: string;
    readonly path: readonly string[];
    readonly args: readonly unknown[];
  }) => Effect.Effect<unknown, BindingError>;
}

export interface BindingContext {
  /** Declared integration roles from the tool descriptor. */
  readonly declared: Readonly<Record<string, IntegrationDecl>>;
  /** Resolved role -> connection address choices for this invocation. */
  readonly bindings: RoleBindings;
  /** The invoking scope's app database (bound to the `db` root). */
  readonly db: ScopeDbHandle;
  /** Routes a bound method call to the real integration. */
  readonly resolver: ClientResolver;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const bindingError = (
  role: string,
  integration: string,
  message: string,
  requestedConnection?: string,
): BindingError =>
  new BindingError({
    message,
    role,
    integration,
    requestedConnection,
  });

const findDefaultConnection = (
  role: string,
  decl: IntegrationDecl,
  resolver: ClientResolver,
): Effect.Effect<string, BindingError> =>
  resolver.listConnections({ integration: decl.integration }).pipe(
    Effect.flatMap((connections) => {
      if (connections.length === 1) return Effect.succeed(connections[0]!.address);
      return Effect.fail(
        bindingError(
          role,
          decl.integration,
          connections.length === 0
            ? `missing required connection for role "${role}" (${decl.integration}); no connections are available`
            : `missing required connection for role "${role}" (${decl.integration}); choose one of ${connections
                .map((c) => c.address)
                .join(", ")}`,
        ),
      );
    }),
  );

const resolveRequestedConnection = (
  role: string,
  decl: IntegrationDecl,
  requested: string,
  resolver: ClientResolver,
): Effect.Effect<string, BindingError> =>
  resolver.resolveConnection({ connection: requested }).pipe(
    Effect.flatMap((connection) => {
      if (!connection) {
        return Effect.fail(
          bindingError(
            role,
            decl.integration,
            `unknown connection "${requested}" for role "${role}" (${decl.integration})`,
            requested,
          ),
        );
      }
      if (connection.integration !== decl.integration) {
        return Effect.fail(
          bindingError(
            role,
            decl.integration,
            `connection "${requested}" belongs to integration "${connection.integration}", not "${decl.integration}" for role "${role}"`,
            requested,
          ),
        );
      }
      return Effect.succeed(connection.address);
    }),
  );

export interface ResolvedIntegrationBindings {
  readonly input: unknown;
  readonly bindings: RoleBindings;
}

/** Peel platform-added role properties from the caller payload and resolve them
 *  to concrete connection addresses. */
export const resolveIntegrationBindings = (
  declared: Readonly<Record<string, IntegrationDecl>>,
  args: unknown,
  resolver: ClientResolver,
): Effect.Effect<ResolvedIntegrationBindings, BindingError> =>
  Effect.gen(function* () {
    const roles = Object.entries(declared);
    if (roles.length === 0) return { input: args, bindings: {} };

    const payload = isRecord(args) ? args : {};
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!Object.prototype.hasOwnProperty.call(declared, key)) input[key] = value;
    }

    const bindings: Record<string, string> = {};
    for (const [role, decl] of roles) {
      const raw = payload[role];
      if (raw === undefined) {
        bindings[role] = yield* findDefaultConnection(role, decl, resolver);
        continue;
      }
      if (typeof raw !== "string" || raw.length === 0) {
        return yield* Effect.fail(
          bindingError(
            role,
            decl.integration,
            `connection for role "${role}" (${decl.integration}) must be a non-empty string`,
            typeof raw === "string" ? raw : undefined,
          ),
        );
      }
      bindings[role] = yield* resolveRequestedConnection(role, decl, raw, resolver);
    }

    return { input, bindings };
  });

/** Compute the sandbox handle roots: `db` plus one single root per declared
 *  integration role. */
export const rootsFor = (
  declared: Readonly<Record<string, IntegrationDecl>>,
): Readonly<Record<string, HandleRootSpec>> => {
  const roots: Record<string, HandleRootSpec> = { db: { kind: "single" } };
  for (const role of Object.keys(declared)) {
    roots[role] = { kind: "single" };
  }
  return roots;
};

// Parse an indexed root name. Indexed roots are not supported in v1, but the
// parser lets the bridge reject `role#0` explicitly instead of misrouting it.
const parseRoot = (root: string): { role: string; index?: number } => {
  const hash = root.indexOf("#");
  if (hash === -1) return { role: root };
  return { role: root.slice(0, hash), index: Number(root.slice(hash + 1)) };
};

const RESERVED_ROOTS = new Set(["__proto__", "constructor", "prototype"]);

const invokeErr = (message: string): ToolSandboxError =>
  new ToolSandboxError({ kind: "invoke", message });

/**
 * Build the HandleBridge the sandbox calls out through. `db` routes to the
 * scope database; a declared role routes to its resolved connection through the
 * `ClientResolver`. The dispatch is STRICT: an empty/malformed path, a reserved
 * root, an undeclared root, or an indexed root is an error, never a silent
 * success. A `.account` read on a client returns bound-connection metadata
 * without a round-trip.
 */
export const buildBridge = (context: BindingContext): HandleBridge => ({
  call: ({ root, path, args }) => {
    if (typeof root !== "string" || root.length === 0) {
      return Effect.fail(invokeErr("bridge call is missing a handle root"));
    }
    if (!Array.isArray(path) || path.length === 0) {
      return Effect.fail(invokeErr(`bridge call to "${root}" has an empty method path`));
    }
    if (RESERVED_ROOTS.has(root)) {
      return Effect.fail(invokeErr(`reserved handle root is not callable: ${root}`));
    }

    if (root === "db") {
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
      return Effect.fail(invokeErr(`unsupported db call: ${path.join(".")}`));
    }

    const { role, index } = parseRoot(root);
    if (index !== undefined) {
      return Effect.fail(
        invokeErr(`single integration role "${role}" was addressed with an index`),
      );
    }

    const decl = context.declared[role];
    if (!decl) {
      return Effect.fail(invokeErr(`undeclared handle root: ${root}`));
    }

    const connectionName = context.bindings[role];
    if (!connectionName) {
      return Effect.fail(invokeErr(`no binding for role ${role}`));
    }
    if (path.length === 1 && path[0] === "account") {
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
