/** Author routers and the lookups that walk them. Declarations run no handler and contact no source. */
import { Effect, Schema } from "effect";
import { HostedTool } from "../contracts/host.ts";
import type { AppOperation } from "../contracts/operations.ts";
import {
  RouterKey,
  RouterMeta,
  reservedRouterKeys,
  type AppNode,
  type AppRouter,
  type DynamicRouter,
  type RouterIcon,
} from "../contracts/router.ts";
import { fromPromise } from "./authoring.ts";
import { extendRoot } from "./router-extend.ts";
import type { Approval } from "../approval.ts";
import {
  NativeRouterKey as NativeRouter,
  approvedOperation,
  nativeOperation,
  operationDeclaration,
  type OperationChild,
  type OperationDeclaration,
  type RouterChild,
  type RouterDeclaration,
} from "./operations.ts";

export type {
  OperationChild,
  OperationDeclaration,
  RouterChild,
  RouterDeclaration,
} from "./operations.ts";

/** Author metadata for a router. Instructions become a skill named after the router's path. */
export interface RouterOptions {
  readonly title?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly icons?: readonly RouterIcon[];
  readonly tags?: Readonly<Record<string, string>>;
}

/** Wrap a native router. Protocol helpers use this for the routers they build. */
export const routerDeclaration = (node: AppRouter | DynamicRouter): RouterDeclaration => ({
  [NativeRouter]: node,
});

/** Accept only framework-created routers. */
export const nativeRouter = (value: unknown): AppRouter | DynamicRouter | undefined => {
  if (typeof value !== "object" || value === null || !(NativeRouter in value)) return undefined;
  // SAFETY: only routerDeclaration installs this private symbol, always with a native router.
  return value[NativeRouter] as AppRouter | DynamicRouter;
};

const nativeNode = (value: unknown): AppNode | undefined =>
  nativeOperation(value) ?? nativeRouter(value);

const metaOf = (options: RouterOptions | undefined): RouterMeta | undefined => {
  if (options === undefined) return undefined;
  const defined = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
  return Object.keys(defined).length === 0
    ? undefined
    : Schema.decodeUnknownSync(RouterMeta)(defined);
};

/** Author fields win; a field the author omits keeps the source's value. */
export const mergeMeta = (
  base: RouterMeta | undefined,
  override: RouterMeta | undefined,
): RouterMeta | undefined =>
  base === undefined ? override : override === undefined ? base : { ...base, ...override };

/**
 * Group operations and routers under path keys, like tRPC's nested routers, with metadata an
 * agent can read. Passing an existing router instead of children overrides its metadata:
 * `router(mcpRouter(options), { description: "..." })`. A third argument adds named local
 * operations at the same root, without renaming source paths. Collisions refuse rather than
 * override: `router(source, {}, { localOperation })`.
 */
export function router<Query = unknown, Mutation = unknown>(
  children: Readonly<Record<string, RouterChild<Query, Mutation>>>,
  options?: RouterOptions,
): RouterDeclaration<Query, Mutation>;
export function router<Query, Mutation>(
  source: RouterDeclaration<Query, Mutation>,
  options: RouterOptions,
  additions?: Readonly<Record<string, OperationChild<Query, Mutation>>>,
): RouterDeclaration<Query, Mutation>;
export function router(
  children: Readonly<Record<string, unknown>> | RouterDeclaration,
  options?: RouterOptions,
  additions?: Readonly<Record<string, unknown>>,
): RouterDeclaration {
  const meta = metaOf(options);
  let existing = nativeRouter(children);
  if (additions !== undefined) {
    if (existing === undefined) throw new Error("Same-root additions require an existing router");
    const operations: Record<string, AppOperation> = {};
    for (const [name, value] of Object.entries(additions)) {
      if (!Schema.is(RouterKey)(name)) throw new Error("Invalid same-root operation name");
      const operation = nativeOperation(value);
      if (operation === undefined)
        throw new Error("Same-root additions must be queries or mutations");
      operations[name] = operation;
    }
    existing = extendRoot(existing, operations);
  }
  if (existing !== undefined)
    return routerDeclaration(
      existing.kind === "router"
        ? { ...existing, ...withMeta(mergeMeta(existing.meta, meta)) }
        : { ...existing, ...withOverrides(mergeMeta(existing.overrides, meta)) },
    );
  const nodes: Record<string, AppNode> = {};
  for (const [key, value] of Object.entries(children)) {
    if (reservedRouterKeys.has(key)) throw new Error(`Router key "${key}" is reserved`);
    if (!Schema.is(RouterKey)(key))
      throw new Error(`Router key "${key}" must start with a letter or _ and contain no dots`);
    const node = nativeNode(value);
    if (node === undefined)
      throw new Error(`Router key "${key}" must be a query, mutation or router`);
    nodes[key] = node;
  }
  return routerDeclaration({ kind: "router", ...withMeta(meta), children: nodes });
}

const withMeta = (meta: RouterMeta | undefined) => (meta === undefined ? {} : { meta });
const withOverrides = (overrides: RouterMeta | undefined) =>
  overrides === undefined ? {} : { overrides };

/**
 * Declare a router whose tools are discovered when read. `list` returns tools with names relative
 * to this router; mark queries with `readOnly: true`, and add `kindConfirmed: true` when your code,
 * not an upstream service's claim, decides the kind. `resolve` receives one of those names.
 * The router carries the handler contexts of the operations `resolve` returns, so `defineApp`
 * checks them like a static router's.
 */
export const dynamicRouter = <Query = unknown, Mutation = unknown>(source: {
  readonly meta?: () => RouterOptions | Promise<RouterOptions>;
  readonly list: () => readonly HostedTool[] | Promise<readonly HostedTool[]>;
  readonly resolve: (
    name: string,
  ) =>
    | OperationChild<Query, Mutation>
    | undefined
    | Promise<OperationChild<Query, Mutation> | undefined>;
}): RouterDeclaration<Query, Mutation> => {
  const meta = source.meta;
  return routerDeclaration({
    kind: "dynamic",
    ...(meta === undefined
      ? {}
      : {
          meta: () =>
            fromPromise(async () => meta(), "router")().pipe(
              Effect.flatMap((options) => Schema.decodeUnknownEffect(RouterMeta)(options)),
            ),
        }),
    list: () =>
      fromPromise(async () => source.list(), "router")().pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HostedTool))),
      ),
    resolve: (name) =>
      fromPromise(async () => source.resolve(name), "router")().pipe(
        Effect.map((value) => {
          if (value === undefined) return undefined;
          const operation = nativeOperation(value);
          if (operation === undefined) throw new Error("Expected an operation declaration");
          return operation;
        }),
      ),
  });
};

/** Join a router path and a relative name. The root router's path is "". */
export const joinPath = (path: string, name: string) => (path === "" ? name : `${path}.${name}`);

/** Where a full tool name points: a declared operation, or a name inside a dynamic router. */
export type Location =
  | { readonly kind: "operation"; readonly operation: AppOperation; readonly router: string }
  | {
      readonly kind: "dynamic";
      readonly source: DynamicRouter;
      readonly router: string;
      readonly name: string;
    };

/**
 * Walk static keys until the name ends at an operation or enters a dynamic router, which receives
 * the rest of the name. Static keys contain no dots, so every name has at most one location.
 */
export const locate = (
  root: AppRouter | DynamicRouter | undefined,
  name: string,
): Location | undefined => {
  if (root?.kind === "dynamic") return { kind: "dynamic", source: root, router: "", name };
  let current: AppRouter | undefined = root;
  let path = "";
  let rest = name;
  while (current !== undefined) {
    const dot = rest.indexOf(".");
    const key = dot < 0 ? rest : rest.slice(0, dot);
    const child = Object.hasOwn(current.children, key) ? current.children[key] : undefined;
    if (child === undefined) return undefined;
    const remaining = dot < 0 ? undefined : rest.slice(dot + 1);
    switch (child.kind) {
      case "query":
      case "mutation":
        return remaining === undefined
          ? { kind: "operation", operation: child, router: path }
          : undefined;
      case "dynamic":
        return remaining === undefined || remaining === ""
          ? undefined
          : { kind: "dynamic", source: child, router: joinPath(path, key), name: remaining };
      case "router":
        if (remaining === undefined) return undefined;
        current = child;
        path = joinPath(path, key);
        rest = remaining;
    }
  }
  return undefined;
};

/** Every declared operation with its full name and owning router. Dynamic routers are not listed. */
export const declaredOperations = (
  root: AppRouter | undefined,
  path = "",
): Array<{ readonly name: string; readonly router: string; readonly operation: AppOperation }> =>
  Object.entries(root?.children ?? {}).flatMap(([key, child]) => {
    const name = joinPath(path, key);
    switch (child.kind) {
      case "query":
      case "mutation":
        return [{ name, router: path, operation: child }];
      case "router":
        return declaredOperations(child, name);
      case "dynamic":
        return [];
    }
  });

/**
 * Choose an approval for each operation a router contains, including tools a dynamic router
 * resolves later. `policy` receives the operation and its name relative to this router; returning
 * undefined keeps the operation's own approval. Read hints with `toolAnnotations(operation)`.
 * Apply it to each account's router before `accountRouter` combines them, so every account keeps
 * its own tools' hints.
 */
export const withApprovals = <Query, Mutation>(
  source: RouterDeclaration<Query, Mutation>,
  policy: (
    operation: OperationDeclaration<"query" | "mutation", never>,
    name: string,
  ) => Approval | undefined,
): RouterDeclaration<Query, Mutation> => {
  const native = nativeRouter(source);
  if (native === undefined) throw new Error("withApprovals expects a router");
  const operation = (node: AppOperation, name: string): AppOperation => {
    const approval = policy(operationDeclaration(node), name);
    return approval === undefined ? node : approvedOperation(node, approval);
  };
  const child = (node: AppNode, name: string): AppNode => {
    switch (node.kind) {
      case "query":
      case "mutation":
        return operation(node, name);
      case "router":
      case "dynamic":
        return walk(node, name);
    }
  };
  const walk = (node: AppRouter | DynamicRouter, path: string): AppRouter | DynamicRouter =>
    node.kind === "dynamic"
      ? {
          ...node,
          resolve: (name) =>
            node.resolve(name).pipe(
              Effect.flatMap((resolved) =>
                resolved === undefined
                  ? Effect.succeed(undefined)
                  : Effect.try({
                      try: () => operation(resolved, joinPath(path, name)),
                      catch: (error) => error,
                    }),
              ),
            ),
        }
      : {
          ...node,
          children: Object.fromEntries(
            Object.entries(node.children).map(([key, value]) => [
              key,
              child(value, joinPath(path, key)),
            ]),
          ),
        };
  return routerDeclaration(walk(native, ""));
};

/**
 * Expose a protocol router's tools under other names, such as the names an earlier client used.
 * `rename` receives each tool's name relative to this router and returns the name to expose, or
 * undefined to leave the tool out. When two tools would share a name, the first listed keeps it.
 * Calls and descriptions find a tool by its exposed name. Works on routers that discover their
 * tools, such as `mcpRouter`, `graphqlRouter` and `liveOpenapiRouter`.
 */
export const renameTools = <Query, Mutation>(
  source: RouterDeclaration<Query, Mutation>,
  rename: (name: string) => string | undefined,
): RouterDeclaration<Query, Mutation> => {
  const native = nativeRouter(source);
  if (native?.kind !== "dynamic") throw new Error("renameTools expects a protocol router");
  /** Exposed name for each listed tool, first listed winning a shared name. */
  const exposed = <T extends { readonly name: string }>(tools: readonly T[]) => {
    const seen = new Set<string>();
    return tools.flatMap((tool) => {
      const name = rename(tool.name);
      if (name === undefined || seen.has(name)) return [];
      seen.add(name);
      return [{ ...tool, name, source: tool.name }];
    });
  };
  const listed = native.summaries ?? native.list;
  /** The source name of an exposed name, read from the listing. */
  const original = (name: string) =>
    listed().pipe(Effect.map((tools) => exposed(tools).find((tool) => tool.name === name)?.source));
  const strip = <T extends { readonly name: string; readonly source: string }>({
    source: _source,
    ...tool
  }: T) => tool;
  return routerDeclaration({
    ...native,
    list: () => native.list().pipe(Effect.map((tools) => exposed(tools).map(strip))),
    ...(native.summaries === undefined
      ? {}
      : {
          summaries: () => listed().pipe(Effect.map((tools) => exposed(tools).map(strip))),
        }),
    describe: (name) =>
      original(name).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.succeed(undefined)
            : (native.describe?.(found) ??
              native.list().pipe(Effect.map((tools) => tools.find((tool) => tool.name === found)))),
        ),
        Effect.map((tool) => (tool === undefined ? undefined : { ...tool, name })),
      ),
    resolve: (name) =>
      original(name).pipe(
        Effect.flatMap((found) =>
          found === undefined ? Effect.succeed(undefined) : native.resolve(found),
        ),
      ),
  });
};
