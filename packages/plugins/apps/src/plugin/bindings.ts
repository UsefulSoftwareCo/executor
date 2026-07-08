import { Data, Effect } from "effect";
import type { InvokeOptions } from "@executor-js/sdk";

import type { AppToolBridge } from "../executor/app-tool-executor";
import type { IntegrationDecl } from "../pipeline/descriptor";

export class BindingError extends Data.TaggedError("BindingError")<{
  readonly message: string;
  readonly role: string;
  readonly integration: string;
  readonly requestedConnection?: string;
}> {}

export interface ConnectionCandidate {
  readonly address: string;
  readonly integration: string;
}

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
    readonly args: unknown;
    readonly invokeOptions?: InvokeOptions;
  }) => Effect.Effect<unknown, BindingError>;
}

export interface ResolvedBindings {
  readonly input: Record<string, unknown>;
  readonly bindings: Readonly<Record<string, string | readonly string[]>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const resolveRequested = (
  field: string,
  decl: IntegrationDecl,
  requested: string,
  resolver: ClientResolver,
): Effect.Effect<string, BindingError> =>
  Effect.gen(function* () {
    const connection = yield* resolver.resolveConnection({ connection: requested });
    if (!connection) {
      const candidates = yield* resolver.listConnections({ integration: decl.slug });
      return yield* new BindingError({
        role: field,
        integration: decl.slug,
        requestedConnection: requested,
        message: `unknown connection "${requested}" for integration field "${field}" (${decl.slug})${candidates.length > 0 ? `; choose one of ${candidates.map((candidate) => candidate.address).join(", ")}` : ""}`,
      });
    }
    if (connection.integration !== decl.slug) {
      return yield* new BindingError({
        role: field,
        integration: decl.slug,
        requestedConnection: requested,
        message: `connection "${requested}" belongs to integration "${connection.integration}", not "${decl.slug}"`,
      });
    }
    return connection.address;
  });

const resolveManyRequested = (
  field: string,
  decl: IntegrationDecl,
  requested: readonly unknown[],
  resolver: ClientResolver,
): Effect.Effect<readonly string[], BindingError> =>
  Effect.forEach(requested, (item) => {
    if (typeof item !== "string" || item.length === 0) {
      return Effect.fail(
        new BindingError({
          role: field,
          integration: decl.slug,
          message: `connection set for integration field "${field}" (${decl.slug}) must contain non-empty strings`,
        }),
      );
    }
    return resolveRequested(field, decl, item, resolver);
  });

export const resolveIntegrationBindings = (
  declared: Readonly<Record<string, IntegrationDecl>>,
  args: unknown,
  resolver: ClientResolver,
): Effect.Effect<ResolvedBindings, BindingError> =>
  Effect.gen(function* () {
    const payload = isRecord(args) ? args : {};
    const input: Record<string, unknown> = { ...payload };
    const bindings: Record<string, string | readonly string[]> = {};
    for (const [field, decl] of Object.entries(declared)) {
      const raw = payload[field];
      if (decl.mode === "many") {
        if (raw === undefined && decl.all) {
          bindings[field] = [];
          continue;
        }
        if (!Array.isArray(raw)) {
          return yield* new BindingError({
            role: field,
            integration: decl.slug,
            message: `connection set for integration field "${field}" (${decl.slug}) must be an array`,
          });
        }
        bindings[field] = yield* resolveManyRequested(field, decl, raw, resolver);
        delete input[field];
        continue;
      }
      if (typeof raw !== "string" || raw.length === 0) {
        return yield* new BindingError({
          role: field,
          integration: decl.slug,
          message: `connection for integration field "${field}" (${decl.slug}) must be a non-empty string`,
          ...(typeof raw === "string" ? { requestedConnection: raw } : {}),
        });
      }
      bindings[field] = yield* resolveRequested(field, decl, raw, resolver);
      delete input[field];
    }
    return { input, bindings };
  });

export const buildBridge = (input: {
  readonly declared: Readonly<Record<string, IntegrationDecl>>;
  readonly bindings: Readonly<Record<string, string | readonly string[]>>;
  readonly resolver: ClientResolver;
  readonly invokeOptions?: InvokeOptions;
}): AppToolBridge => ({
  call: (toolPath, args) => {
    const [root, ...path] = toolPath.split(".");
    const [field, rawIndex] = (root ?? "").split("#");
    const decl = input.declared[field ?? ""];
    const binding = input.bindings[field ?? ""];
    const connection =
      rawIndex === undefined
        ? typeof binding === "string"
          ? binding
          : undefined
        : Array.isArray(binding)
          ? binding[Number(rawIndex)]
          : undefined;
    if (!field || !decl || !connection || path.length === 0) {
      return Effect.runPromise(
        Effect.fail(
          new BindingError({
            role: field ?? "",
            integration: decl?.slug ?? "",
            message: `undeclared integration call: ${toolPath}`,
          }),
        ),
      );
    }
    return Effect.runPromise(
      input.resolver.call({
        integration: decl.slug,
        connection,
        path,
        args,
        invokeOptions: input.invokeOptions,
      }),
    );
  },
});
