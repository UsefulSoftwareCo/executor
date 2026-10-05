/**
 * Read a live router tree into tools, routers and router skills. A nested dynamic router that fails
 * is reported on its own entry; the root failing fails the read, as a single-source app would.
 */
import { Cause, Effect, Option, Result, Schema } from "effect";
import {
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostedRouter,
  HostedTool,
  HostedToolSummary,
  type HostRouterError,
} from "../contracts/host.ts";
import { McpError } from "../contracts/mcp.ts";
import type { AppOperation } from "../contracts/operations.ts";
import type { AppRouter, DynamicRouter, RouterMeta } from "../contracts/router.ts";
import { SkillLoadFailed, skillFormatLimits, type AppSkillSource } from "../contracts/skills.ts";
import { failureDetail } from "./failure-detail.ts";
import { parseProviderError } from "./provider-error.ts";
import { joinPath, mergeMeta } from "./router.ts";
import { skillFromFiles } from "./skill-files.ts";
import { jsonSchemaDocument } from "./schema.ts";
import type { OperationSchedule } from "../contracts/schedules.ts";

/**
 * Keep only a failure's safe fields. Anything unrecognized becomes an evaluation failure with the
 * error's name and bounded message, with the given account secrets replaced.
 */
export const safeFailure = (error: unknown, secrets: readonly string[]): HostRouterError => {
  const provider = parseProviderError(error);
  if (Option.isSome(provider)) return provider.value;
  const skills = Schema.decodeUnknownOption(SkillLoadFailed)(error);
  if (Option.isSome(skills)) {
    const { reason, message, status } = skills.value;
    return new SkillLoadFailed({
      reason,
      ...(message ? { message } : {}),
      ...(status === undefined ? {} : { status }),
    });
  }
  const mcp = Schema.decodeUnknownOption(McpError)(error);
  if (Option.isSome(mcp)) {
    const { phase, reason, status, initialized, fallback } = mcp.value;
    return new McpError({
      phase,
      reason,
      ...(status === undefined ? {} : { status }),
      ...(initialized === undefined ? {} : { initialized }),
      ...(fallback === undefined ? {} : { fallback }),
    });
  }
  if (Schema.is(HostDeclarationInvalid)(error)) return error;
  return new HostEvaluationFailed(failureDetail(error, secrets));
};

/** Run source code; interruption propagates and every other failure keeps only its safe fields. */
const sourced = <A>(work: () => Effect.Effect<A, unknown>, secrets: readonly string[]) =>
  Effect.suspend(work).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.fail(safeFailure(Cause.squash(cause), secrets)),
    ),
  );

/** The metadata an agent sees for one router, with author fields over the source's own. */
const routerMeta = (node: AppRouter | DynamicRouter, secrets: readonly string[]) =>
  node.kind === "router"
    ? Effect.succeed(node.meta)
    : node.meta === undefined
      ? Effect.succeed(node.overrides)
      : sourced(node.meta, secrets).pipe(Effect.map((meta) => mergeMeta(meta, node.overrides)));

/**
 * Router skills are named `tools` for the root and `tools-<path>` below it, so a router's
 * instructions never take an authored skill's name by accident.
 */
export const routerSkillPrefix = "tools";
/** A path segment that already reads as a skill name segment. */
const plainSegment = /^[a-z][a-z0-9]*$/;
/** FNV-1a over the exact path. Router paths are ASCII router keys. */
const pathHash = (path: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index++)
    hash = Math.imul(hash ^ path.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString().padStart(10, "0");
};

/**
 * The skill name for a router path. A path of lowercase letters and digits is spelled out:
 * `issues.open` is `tools-issues-open`. Any other path, or one too long, is a readable slug
 * followed by a hash of the exact path, such as `tools-issues-list-0123456789`. Plain segments
 * start with a letter and a hash is all digits, so the two forms never meet, and paths that slug
 * alike, such as `issues_list` and `issues.list`, get different names.
 */
export const routerSkillName = (path: string) => {
  if (path === "") return routerSkillPrefix;
  const segments = path.split(".");
  const plain = [routerSkillPrefix, ...segments].join("-");
  if (
    segments.every((segment) => plainSegment.test(segment)) &&
    plain.length <= skillFormatLimits.nameCharacters
  )
    return plain;
  const hash = pathHash(path);
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, skillFormatLimits.nameCharacters - routerSkillPrefix.length - hash.length - 2)
    .replace(/^-+|-+$/g, "");
  return [routerSkillPrefix, slug, hash].filter((part) => part !== "").join("-");
};

const entry = (path: string, meta: RouterMeta | undefined, error?: HostRouterError) =>
  Schema.decodeUnknownEffect(HostedRouter)({
    path,
    ...(meta?.title === undefined ? {} : { title: meta.title }),
    ...(meta?.description === undefined ? {} : { description: meta.description }),
    ...(meta?.icons === undefined ? {} : { icons: meta.icons }),
    ...(meta?.tags === undefined ? {} : { tags: meta.tags }),
    ...(meta?.instructions === undefined ? {} : { skill: routerSkillName(path) }),
    ...(error === undefined ? {} : { error }),
  }).pipe(Effect.mapError(() => new HostDeclarationInvalid()));

const invalid = <A>(work: Effect.Effect<A, unknown>) =>
  work.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(new HostDeclarationInvalid()),
    ),
  );

const summaryFields = (
  name: string,
  router: string,
  operation: AppOperation,
  schedules: readonly OperationSchedule[] | undefined,
) => {
  const readOnly = operation.kind === "query";
  return {
    name,
    ...(router === "" ? {} : { router }),
    ...(schedules === undefined ? {} : { schedules }),
    description: operation.description ?? `${readOnly ? "Query" : "Mutate"} ${name}`,
    ...(operation.title === undefined ? {} : { title: operation.title }),
    readOnly,
    annotations: { ...operation.annotations, readOnlyHint: readOnly },
  };
};

/** A declared operation's catalog entry without schemas. `router` is its owning router's path. */
export const operationSummary = (
  name: string,
  router: string,
  operation: AppOperation,
  schedules?: readonly OperationSchedule[],
) =>
  invalid(
    Schema.decodeUnknownEffect(HostedToolSummary)(
      summaryFields(name, router, operation, schedules),
    ),
  );

/** A declared operation's full description, including rendered schemas. */
export const operationDescription = (
  name: string,
  router: string,
  operation: AppOperation,
  schedules?: readonly OperationSchedule[],
) =>
  invalid(
    Effect.gen(function* () {
      return yield* Schema.decodeUnknownEffect(HostedTool)({
        ...summaryFields(name, router, operation, schedules),
        inputSchema: yield* jsonSchemaDocument(operation.input),
        ...(operation.output === undefined
          ? operation.outputSchema === undefined
            ? {}
            : { outputSchema: operation.outputSchema }
          : { outputSchema: yield* jsonSchemaDocument(operation.output) }),
        ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
      });
    }),
  );

/**
 * A dynamic router over operations already discovered, such as an eager OpenAPI document or a
 * stdio server. Upstream names can contain dots, which static router keys cannot.
 */
export const fixedRouter = (
  operations: Readonly<Record<string, AppOperation>>,
  meta?: RouterMeta,
): DynamicRouter => ({
  kind: "dynamic",
  ...(meta === undefined ? {} : { meta: () => Effect.succeed(meta) }),
  list: () =>
    Effect.forEach(Object.entries(operations), ([name, operation]) =>
      operationDescription(name, "", operation),
    ),
  summaries: () =>
    Effect.forEach(Object.entries(operations), ([name, operation]) =>
      operationSummary(name, "", operation),
    ),
  describe: (name) => {
    const operation = Object.hasOwn(operations, name) ? operations[name] : undefined;
    return operation === undefined
      ? Effect.succeed(undefined)
      : operationDescription(name, "", operation);
  },
  resolve: (name) => Effect.succeed(Object.hasOwn(operations, name) ? operations[name] : undefined),
});

export interface CatalogOptions {
  /** Omit schemas. */
  readonly summary: boolean;
  /** Account secrets that a failure's message must not reveal. */
  readonly secrets: readonly string[];
  /** Only these full tool names. Routers with none of them are not read. */
  readonly wanted?: ReadonlySet<string>;
  /** Schedules that target a declared operation, by full name. */
  readonly schedules: (name: string) => readonly OperationSchedule[];
  /**
   * Only declared operations that have schedules. Schedules never target dynamic routers, and
   * their catalogs can be expensive to discover, so none is read.
   */
  readonly scheduled?: true;
}

/** Wanted names inside a router, relative to it. */
const within = (wanted: ReadonlySet<string>, path: string) =>
  [...wanted].flatMap((name) =>
    path === "" ? [name] : name.startsWith(`${path}.`) ? [name.slice(path.length + 1)] : [],
  );

/**
 * Read a router tree. Every nested router is listed, for grouping; the root only when it has
 * metadata. A nested dynamic source that fails is reported on its router's entry.
 */
export const readCatalog = (root: AppRouter | DynamicRouter | undefined, options: CatalogOptions) =>
  Effect.gen(function* () {
    const tools: Array<HostedTool | HostedToolSummary> = [];
    const routers: HostedRouter[] = [];
    const { wanted, secrets } = options;
    /** One source's metadata and tools, named under `path`. `relative` limits a filtered read. */
    const readSource = (source: DynamicRouter, path: string, relative?: readonly string[]) =>
      Effect.gen(function* () {
        const describe = source.describe;
        // Read together, so a source that keeps both in one cached manifest reads it once.
        const [meta, listed] = yield* Effect.all(
          [
            routerMeta(source, secrets),
            options.summary && source.summaries !== undefined
              ? sourced(source.summaries, secrets)
              : relative !== undefined && describe !== undefined
                ? sourced(
                    () =>
                      Effect.forEach(relative, (name) => describe(name), {
                        concurrency: "unbounded",
                      }),
                    secrets,
                  ).pipe(Effect.map((tools) => tools.filter((tool) => tool !== undefined)))
                : sourced(source.list, secrets),
          ],
          { concurrency: "unbounded" },
        );
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.Array(options.summary ? HostedToolSummary : HostedTool),
        )(listed).pipe(Effect.mapError(() => new HostDeclarationInvalid()));
        const names = new Set<string>();
        const found: Array<HostedTool | HostedToolSummary> = [];
        for (const tool of parsed) {
          if (names.has(tool.name)) return yield* new HostDeclarationInvalid();
          names.add(tool.name);
          if (relative !== undefined && !relative.includes(tool.name)) continue;
          const readOnly = tool.readOnly === true;
          found.push({
            ...tool,
            name: joinPath(path, tool.name),
            ...(path === "" ? {} : { router: path }),
            readOnly,
            annotations: { ...tool.annotations, readOnlyHint: readOnly },
          });
        }
        return { meta, found };
      });
    /**
     * Read a source into this catalog. The root is the whole app, so its failure fails the read,
     * as a single-source app did before routers. Elsewhere the failure is returned for the entry.
     */
    const include = (source: DynamicRouter, path: string, relative?: readonly string[]) =>
      Effect.gen(function* () {
        if (path === "") {
          const { meta, found } = yield* readSource(source, path, relative);
          tools.push(...found);
          return { meta, error: undefined };
        }
        const result = yield* Effect.result(readSource(source, path, relative));
        if (Result.isFailure(result)) return { meta: source.overrides, error: result.failure };
        tools.push(...result.success.found);
        return { meta: result.success.meta, error: undefined };
      });
    const visit = (node: AppRouter, path: string): Effect.Effect<void, HostRouterError> =>
      Effect.gen(function* () {
        if (path !== "" || (wanted === undefined && node.meta !== undefined))
          routers.push(yield* entry(path, node.meta));
        for (const [key, child] of Object.entries(node.children)) {
          const name = joinPath(path, key);
          switch (child.kind) {
            case "query":
            case "mutation":
              if (options.scheduled === true && options.schedules(name).length === 0) break;
              if (wanted === undefined || wanted.has(name))
                tools.push(
                  options.summary
                    ? yield* operationSummary(name, path, child, options.schedules(name))
                    : yield* operationDescription(name, path, child, options.schedules(name)),
                );
              break;
            case "router":
              if (wanted === undefined || within(wanted, name).length > 0)
                yield* visit(child, name);
              break;
            case "dynamic": {
              if (options.scheduled === true) break;
              const relative = wanted === undefined ? undefined : within(wanted, name);
              if (relative !== undefined && relative.length === 0) break;
              const read = yield* include(child, name, relative);
              routers.push(yield* entry(name, read.meta, read.error));
            }
          }
        }
      });
    if (root?.kind === "router") yield* visit(root, "");
    else if (root?.kind === "dynamic" && options.scheduled !== true) {
      const read = yield* include(root, "", wanted === undefined ? undefined : [...wanted]);
      if (wanted === undefined && read.meta !== undefined)
        routers.push(yield* entry("", read.meta));
    }
    return { tools, routers };
  });

/**
 * One skill for each router with instructions. Skills and tools fail independently: a dynamic
 * router whose metadata cannot be read, including the root, contributes no skill and does not
 * fail the others. Metadata comes through each source's catalog cache, like a tool listing.
 */
export const routerSkills = (root: AppRouter | DynamicRouter | undefined) =>
  Effect.gen(function* () {
    const nodes: Array<{ readonly path: string; readonly node: AppRouter | DynamicRouter }> = [];
    const collect = (node: AppRouter | DynamicRouter, path: string): void => {
      nodes.push({ path, node });
      if (node.kind === "router")
        for (const [key, child] of Object.entries(node.children))
          if (child.kind === "router" || child.kind === "dynamic")
            collect(child, joinPath(path, key));
    };
    if (root !== undefined) collect(root, "");
    const skills = yield* Effect.forEach(
      nodes,
      ({ path, node }) =>
        // Skills that fail are skipped, so their failures are never reported.
        routerMeta(node, []).pipe(
          Effect.flatMap((meta) => routerSkill(path, meta)),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: "unbounded" },
    );
    const names = new Set<string>();
    return skills.filter((skill): skill is AppSkillSource => {
      if (skill === undefined || names.has(skill.name)) return false;
      names.add(skill.name);
      return true;
    });
  });

/** A router's instructions as a skill, or none when it has no instructions. */
const routerSkill = (path: string, meta: RouterMeta | undefined) =>
  Effect.gen(function* () {
    if (meta?.instructions === undefined) return undefined;
    const name = routerSkillName(path);
    const description = (
      [meta.description, meta.title].find((text) => text !== undefined && text.trim() !== "") ??
      (path === "" ? "How to use this app's tools" : `How to use the ${path} tools`)
    ).slice(0, skillFormatLimits.descriptionCharacters);
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${meta.instructions}\n`;
    return yield* skillFromFiles([{ path: "SKILL.md", content }], { name });
  });
