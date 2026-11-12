/**
 * The one-off repair of organizations moved before the importer took v1's approval stamps and
 * decided the tools v1 did not list (`notes/v1-import.md`, "Repair of moved organizations"). It
 * changes what those fixes change and nothing else, with the importer's own code, so a repaired
 * app holds what an import makes now: an MCP tool whose row v1 stamped as needing approval, and
 * that no policy decided, gets the app's own `always` rule (`toolActions`), and a tool v1 did not
 * list gets what v1's rules give it (`v1ToolRules`). The app's source
 * is generated again, as the importer generates it, and a new version is deployed through the
 * importer's own deploy call. A file the fixes change is replaced only when the deployed one is
 * still an importer's output: the importer's now, before each fix, or a version the import
 * deployed itself.
 *
 * An app its users changed in v2 keeps their code. Where they left its approvals as an importer
 * wrote them, its new version adds v1's approvals beneath it (`v1-approvals.ts`), so no tool asks
 * less than v1 did. Where they changed its approvals, their choice stands and the app is left as it
 * is (`approvalsChanged`).
 *
 * Without `apply` it reports what it would change and writes nothing.
 */
import { CurrentUserId, HostedExecutor, organizationOwner } from "@executor-js/hosted-server";
import { sharedAppCreation } from "@executor-js/hosted-server/resource-lifecycle";
import {
  AppId,
  isTextFile,
  scopeGeneratedPackage,
  VersionId,
  type SourceFile,
} from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1ImportDatabase, V1ImportUnavailable } from "../../contracts/v1-import.ts";
import type { IntegrationRow, ToolRow } from "./formats.ts";
import {
  appMethods,
  approvalRules,
  generate,
  mcpNaming,
  redundantFixed,
  toolActions,
  v1ToolDecisions,
  v1ToolRules,
  type ItemContext,
} from "./items.ts";
import { integrationLabel, integrationPlan } from "./plan.ts";
import { V1ImportEnvironment, firstPartyClients } from "./run.ts";
import { allSnapshotTables, type V1Snapshot, type V1Source } from "./source.ts";
import { makeImportStore, type ImportStore } from "./store.ts";

/** An imported member: their WorkOS user, v2 user and role in the v2 organization. */
const Member = Schema.Struct({ v1: Schema.String, v2: Schema.String, role: Schema.String });

/** Tool rows as the earlier importer read them: without v1's approval stamp. */
export const unstamped = (tools: readonly ToolRow[]): readonly ToolRow[] =>
  tools.map((tool) => ({ ...tool, requires_approval: false }));

/**
 * The tools of an integration's app that the stamp fix makes ask always: the app's `always`
 * rules with v1's stamps, less those it had without them. Only MCP tools change.
 */
export const stampedAlways = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
) => {
  const aliases = integration.plugin_id === "mcp" ? mcpNaming(tools).aliases : {};
  const now = approvalRules(toolActions(snapshot, integration, tools, aliases)).approvals;
  const before = approvalRules(
    toolActions(snapshot, integration, unstamped(tools), aliases),
  ).approvals;
  return Object.keys(now)
    .filter((name) => now[name] === "always" && before[name] !== "always")
    .sort();
};

/**
 * What deciding the tools v1 did not list changes in an app, beside the stamps: the tools v1's
 * rules name, or for OpenAPI the operations v1 compiled (`operations`), that it now leaves out or
 * asks before, and what a tool no rule names gets on a server that lists tools as it runs. Null
 * when nothing changes.
 */
export const unlistedChange = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  operations?: readonly string[],
) => {
  const aliases = integration.plugin_id === "mcp" ? mcpNaming(tools).aliases : {};
  const before = approvalRules(toolActions(snapshot, integration, tools, aliases));
  const now = v1ToolRules(snapshot, integration, tools, aliases, operations);
  const change = {
    omitted: (now.omitted ?? []).filter((name) => !before.omitted.includes(name)).sort(),
    always: Object.keys(now.approvals ?? {})
      .filter((name) => now.approvals?.[name] === "always" && before.approvals[name] !== "always")
      .sort(),
    otherwise: now.otherwise?.rule ?? null,
  };
  return change.omitted.length === 0 && change.always.length === 0 && change.otherwise === null
    ? null
    : change;
};

/**
 * What v1 did with an app's tools, by the names the app exposes: the least each may ask in v2.
 * `known` is every name v1's rules decide; on a server that lists tools as it runs, another tool
 * gets what v1's rules give a name they do not spell out (`otherwise`).
 */
export interface V1Floor {
  readonly plugin: string;
  readonly blocked: readonly string[];
  readonly asked: readonly string[];
  readonly allowed: readonly string[];
  readonly known: readonly string[];
  readonly otherwise: "block" | "require_approval" | "default";
}

/** An integration's v1 floor, from the rules the importer writes (`v1ToolDecisions`). */
export const v1Floor = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  operations?: readonly string[],
): V1Floor => {
  const aliases = integration.plugin_id === "mcp" ? mcpNaming(tools).aliases : {};
  const { actions, unnamed } = v1ToolDecisions(snapshot, integration, tools, aliases, operations);
  const named = (action: string) =>
    [...actions]
      .filter(([, decided]) => decided === action)
      .map(([name]) => name)
      .sort();
  return {
    plugin: integration.plugin_id,
    blocked: named("block"),
    asked: named("require_approval"),
    allowed: named("approve"),
    known: [...actions.keys()].sort(),
    otherwise: unnamed === "block" || unnamed === "require_approval" ? unnamed : "default",
  };
};

/** The file of v1's approvals beneath an app changed in v2. */
export const floorPath = "v1-approvals.ts";

/**
 * Where v1's approvals go in an app changed in v2: into the `withApprovals` its own code chooses
 * approvals with, so each tool gets one approval, the stricter of the two; or, when its code calls
 * no `withApprovals`, over every tool its `defineApp` defines.
 */
export type FloorPlace = "withApprovals" | "defineApp";

/**
 * `v1-approvals.ts`: `withApprovals` or `defineApp` from `apps`, with v1's approvals beneath the
 * app's own. A tool v1 blocked is refused, one v1 asked before asks, and one v1 ran without asking
 * is left to the app. Any other tool gets v1's default: on MCP, what v1 stamped a tool the server
 * marks destructive with, or what v1's catch-all rule gives it; on OpenAPI and GraphQL, asking
 * before a mutation, as v1 did. Combined with the app's own approval, the stricter one decides.
 */
export const floorFile = (floor: V1Floor, place: FloorPlace) => {
  const mcp = floor.plugin === "mcp";
  const fallback = mcp
    ? "toolAnnotations(tool)?.destructiveHint === true ? always() : undefined"
    : 'tool.kind === "mutation" ? always() : undefined';
  const other =
    floor.otherwise === "block"
      ? "refused"
      : floor.otherwise === "require_approval"
        ? "always()"
        : fallback;
  const set = (values: readonly string[]) => `new Set<string>(${JSON.stringify(values, null, 2)})`;
  const imports = [
    ...(place === "defineApp" ? ["defineApp as appsDefineApp"] : []),
    ...(mcp ? ["toolAnnotations"] : []),
    "withApprovals as appsWithApprovals",
  ];
  const exported =
    place === "withApprovals"
      ? `const rank = { approved: 0, "user-approval": 1, denied: 2 } as const

/** The stricter of two approvals; undefined keeps the tool's own. */
const stricter = (first: Approval | undefined, second: Approval | undefined): Approval | undefined =>
  first === undefined
    ? second
    : second === undefined
      ? first
      : async (context) => {
          const [one, two] = await Promise.all([first(context), second(context)])
          return rank[one] >= rank[two] ? one : two
        }

/** withApprovals from apps, with v1's approvals beneath the app's own policy. */
export const withApprovals: typeof appsWithApprovals = (router, policy) =>
  appsWithApprovals(router, (tool, name) => stricter(least(tool, name), policy(tool, name)))
`
      : `/** defineApp from apps, with v1's approvals over the app's tools, which set none of their own. */
export const defineApp: typeof appsDefineApp = (requirements, definition) =>
  appsDefineApp(requirements, async (context) => {
    const app = typeof definition === "function" ? await definition(context) : definition
    return app.tools === undefined ? app : { ...app, tools: appsWithApprovals(app.tools, least) }
  })
`;
  return `/**
 * v1's approvals for this app, from Executor's move from v1. The app was changed in v2, so the move
 * kept its code and added this file, which the app takes ${place} from instead of apps. It is
 * the same ${place}, except that each tool asks at least as v1 asked before running it, and a
 * tool v1 blocked is refused. The app's own rules decide everything else.
 */
import { ${imports.join(", ")} } from "apps"
import { always } from "apps/operations/approval"

type Policy = Parameters<typeof appsWithApprovals>[1]
type Approval = NonNullable<ReturnType<Policy>>

/** Tools v1 blocked. */
const blocked = ${set(floor.blocked)}

/** Tools v1 asked before running. */
const asked = ${set(floor.asked)}

/** Tools v1 ran without asking. */
const allowed = ${set(floor.allowed)}

/** Every tool v1's rules decide; ${mcp ? "the server may list others" : "any other is one v1 did not have"}. */
const known = ${set(floor.known)}

const refused: Approval = () => "denied"

/** The least a tool asks, by the name the app exposes, or undefined to leave it to the app. */
const least: Policy = (tool, name) =>
  blocked.has(name)
    ? refused
    : asked.has(name)
      ? always()
      : allowed.has(name)
        ? undefined
        : known.has(name)
          ? ${mcp ? "undefined" : fallback}
          : ${other}

${exported}`;
};

/** A named import from `apps`, its specifiers in braces. */
const appsImport = /import\s*\{([^}]*)\}\s*from\s*(["'])apps\2[ \t]*;?/gu;
const specifiers = (list: string) =>
  list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
/** Whether a specifier imports `name`, under its own name or another. */
const imports = (specifier: string, name: string) =>
  specifier === name || specifier.startsWith(`${name} as `);

/**
 * A file's source taking `name` from v1's approvals instead of `apps`, at `from` relative to it,
 * keeping any local name it gives it. Unchanged when it does not import `name` from `apps`.
 */
export const flooredImports = (content: string, name: FloorPlace, from: string) =>
  content.replace(appsImport, (statement, list: string) => {
    const all = specifiers(list);
    const taken = all.filter((specifier) => imports(specifier, name));
    if (taken.length === 0) return statement;
    const rest = all.filter((specifier) => !imports(specifier, name));
    return `${rest.length === 0 ? "" : `import { ${rest.join(", ")} } from "apps"\n`}import { ${taken.join(", ")} } from "${from}"`;
  });

const codeFile = /\.[cm]?[jt]sx?$/u;

/**
 * The files of an app changed in v2 with v1's approvals beneath its own code: the deployed files,
 * the files that import `withApprovals` (or, without any, `index.ts`'s `defineApp`) taking it from
 * `v1-approvals.ts`, and that file. `done` when the deployed app already has them. A reason
 * instead when they cannot be added without changing what the app's own code does.
 */
export const flooredFiles = (deployed: readonly SourceFile[], floor: V1Floor) => {
  const code = deployed.filter(
    (file) => codeFile.test(file.path) && file.path !== floorPath && isTextFile(file),
  );
  const text = (file: SourceFile) => (isTextFile(file) ? file.content : "");
  const index = code.find((file) => file.path === "index.ts");
  if (index === undefined) return { reason: "It has no index.ts to take v1's approvals." } as const;
  // The names a file imports `name` from `apps` under, and whether it calls it by one of them.
  const local = (specifier: string) => specifier.split(/\s+as\s+/u).at(-1) ?? specifier;
  const names = (file: SourceFile, name: string) =>
    [...text(file).matchAll(appsImport)].flatMap((found) =>
      specifiers(found[1] ?? "")
        .filter((specifier) => imports(specifier, name))
        .map(local),
    );
  const reaches = (name: string) => code.some((file) => names(file, name).length > 0);
  const calls = (name: string) =>
    code.some((file) =>
      names(file, name).some((alias) => new RegExp(`\\b${alias}\\s*\\(`, "u").test(text(file))),
    );
  const from = (path: string) =>
    `${path.includes("/") ? "../".repeat(path.split("/").length - 1) : "./"}${floorPath}`;
  // An earlier repair's file says where it went: the imports it rewrote no longer name apps.
  const kept = deployed.find((file) => file.path === floorPath);
  const place: FloorPlace =
    kept === undefined
      ? calls("withApprovals")
        ? "withApprovals"
        : "defineApp"
      : text(kept).includes("export const withApprovals")
        ? "withApprovals"
        : "defineApp";
  // Each tool must get one approval: through an import these do not rewrite, a second one fails.
  if (code.some((file) => /import\s+(\*\s+as\s+)?\w+\s+from\s+["']apps["']/u.test(text(file))))
    return { reason: "It imports apps as a whole, so its approvals cannot take v1's." } as const;
  if (place === "defineApp" && kept === undefined && !reaches("defineApp"))
    return { reason: "Its index.ts does not import defineApp from apps." } as const;
  // Over every tool, the approvals replace each operation, which a schedule or workflow names.
  if (place === "defineApp" && code.some((file) => /\b(schedules|workflows)\s*:/u.test(text(file))))
    return {
      reason:
        "It schedules or runs workflows over tools that set no approvals, which v1's would replace.",
    } as const;
  const approvals = { path: floorPath, content: floorFile(floor, place) };
  const files: readonly SourceFile[] = [
    ...deployed.flatMap((file): SourceFile[] => {
      if (file.path === floorPath) return [];
      if (!code.includes(file) || !isTextFile(file)) return [file];
      return [{ ...file, content: flooredImports(file.content, place, from(file.path)) }];
    }),
    approvals,
  ];
  const changed = files
    .filter((file) => fileKey(file) !== fileKey(deployed.find((one) => one.path === file.path)))
    .map((file) => file.path)
    .sort();
  return { files, changed, done: changed.length === 0 };
};

export interface AppRepair {
  readonly integration: string;
  readonly app: string;
  readonly always: readonly string[];
  readonly unlisted: ReturnType<typeof unlistedChange>;
  /**
   * `deploy` a new version, leave it `unchanged`, leave it `kept` as its users changed its
   * approvals in v2, or leave it for a `manual` decision when v1's approvals cannot be added beneath
   * its users' code (`reason`).
   */
  readonly decision: "deploy" | "unchanged" | "kept" | "manual" | "removed" | "failed";
  /**
   * Whether the deployed files the fixes change are an importer's output (`generated`), or were
   * changed in v2 (`edited`), so the new version adds v1's approvals beneath them.
   */
  readonly source?: "generated" | "edited";
  /** The files the new version changes, or the edited ones. */
  readonly files: readonly string[];
  readonly reason?: string;
  /** For a manual decision, the tools v1 asked before and blocked, by the names the app exposes. */
  readonly v1?: Pick<V1Floor, "asked" | "blocked">;
}

export interface OrganizationRepair {
  readonly organization: string;
  readonly v2Organization: string | null;
  readonly applied: boolean;
  readonly status: "repaired" | "planned" | "not_imported";
  readonly apps: readonly AppRepair[];
}

const fileKey = (file: SourceFile | undefined) =>
  file === undefined ? null : JSON.stringify(file);

/** The files an app's tools and their approvals are declared in. */
const ruleFiles = ["index.ts", "tools.ts"];

/** Source without comments, white space, semicolons, commas or parentheses: what it says. */
const unformatted = (content: string) =>
  content
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1")
    .replace(/[\s;,()]/gu, "");

/** The policy each `withApprovals` call in a file passes: its arguments after the router. */
const policies = (content: string) =>
  [...content.matchAll(/\bwithApprovals\s*\(/gu)].map((call) => {
    let depth = 1;
    let policy = -1;
    let index = (call.index ?? 0) + call[0].length;
    for (; index < content.length && depth > 0; index++) {
      const char = content[index];
      if (char === "(" || char === "[" || char === "{") depth++;
      else if (char === ")" || char === "]" || char === "}") depth--;
      else if (char === "," && depth === 1 && policy < 0) policy = index + 1;
    }
    return policy < 0 ? "" : unformatted(content.slice(policy, index - 1));
  });

/** Code that decides approvals itself: it imports the approval helpers or returns an approval. */
const decidesApprovals = /apps\/operations\/approval|["'](?:approved|user-approval|denied)["']/u;

/**
 * What decides an app's approvals, compared without layout: the policy each `withApprovals` call
 * passes, `tools.ts`, which holds the app's approval rules and the tools it leaves out, and which
 * other files of its own decide approvals. An earlier repair's `v1-approvals.ts` is not the app's.
 */
const approvalCode = (files: readonly SourceFile[]) => {
  const code = files.filter(
    (file) => codeFile.test(file.path) && file.path !== floorPath && isTextFile(file),
  );
  const text = (file: SourceFile | undefined) =>
    file !== undefined && isTextFile(file) ? file.content : "";
  return JSON.stringify({
    policies: code.flatMap((file) => policies(text(file))).sort(),
    tools: unformatted(text(code.find((file) => file.path === "tools.ts"))),
    own: code
      .filter((file) => !ruleFiles.includes(file.path) && decidesApprovals.test(text(file)))
      .map((file) => file.path)
      .sort(),
  });
};

/**
 * Whether an app's users changed its approvals in v2: what decides them is none of the importer's
 * outputs (`outputs`). Their choice stands, even where it asks less than v1 did (decision 31).
 */
export const approvalsChanged = (
  deployed: readonly SourceFile[],
  outputs: readonly (readonly SourceFile[])[],
) => outputs.every((output) => approvalCode(output) !== approvalCode(deployed));

/**
 * The files of a new version: the deployed ones, with each file the fixes change taken from the
 * importer's output now. Undefined, with the paths that block it, when a file the fixes change, or
 * a file the app declares its tools' approvals in, is neither an importer's output now nor an
 * earlier one: the importer's before each fix (`before`), or a version the import deployed itself
 * (`imported`). `done` when every file the fixes change is already the importer's output now, as
 * after an earlier repair.
 *
 * A new version also replaces each other file still as an import deployed it, which an earlier
 * importer may have written differently, so the app holds one importer's output: the output now.
 */
export const mergedFiles = (
  deployed: readonly SourceFile[],
  before: readonly (readonly SourceFile[])[],
  after: readonly SourceFile[],
  imported: readonly (readonly SourceFile[])[] = [],
) => {
  const at = (files: readonly SourceFile[], path: string) =>
    files.find((file) => file.path === path);
  const same = (files: readonly SourceFile[], path: string) =>
    fileKey(at(deployed, path)) === fileKey(at(files, path));
  const paths = [...new Set([...before.flat(), ...after].map((file) => file.path))].filter((path) =>
    before.some((earlier) => fileKey(at(earlier, path)) !== fileKey(at(after, path))),
  );
  const checked = [
    ...new Set([
      ...paths,
      ...ruleFiles.filter(
        (path) => at(deployed, path) !== undefined || at(after, path) !== undefined,
      ),
    ]),
  ];
  const older = checked.filter(
    (path) => !same(after, path) && before.every((earlier) => !same(earlier, path)),
  );
  const blocked = older.filter((path) => imported.every((version) => !same(version, path)));
  const done = blocked.length === 0 && paths.every((path) => same(after, path));
  if (done || blocked.length > 0) return { changed: paths, blocked, files: undefined, done };
  const kept = [...new Set([...imported.flat(), ...after].map((file) => file.path))].filter(
    (path) =>
      !paths.includes(path) &&
      !same(after, path) &&
      imported.some((version) => at(version, path) !== undefined && same(version, path)),
  );
  const changed = [...paths, ...kept].sort();
  const files = [
    ...deployed.filter((file) => !changed.includes(file.path)),
    ...changed.flatMap((path) => {
      const file = at(after, path);
      return file === undefined ? [] : [file];
    }),
  ];
  return { changed, blocked, files, done };
};

/** A source whose tool rows read as the earlier importer read them. */
const withoutStamps = (source: V1Source): V1Source => ({
  ...source,
  tools: (tenant, subjects, integration) =>
    source.tools(tenant, subjects, integration).pipe(Effect.map(unstamped)),
});

/** The members an import moved: their WorkOS user, v2 user and role in the v2 organization. */
export const importedMembers = (sql: SqlClient.SqlClient, organization: string) =>
  sql`
    select u.v1_id as v1, m."userId" as v2, m.role from member m
    join private_v1_import_map u on u.v1_kind = 'user' and u.v2_id = m."userId"
    where m."organizationId" = ${organization} order by m."createdAt", u.v1_id
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Member))),
    Effect.mapError(() => new V1ImportUnavailable()),
  );

/**
 * Each imported app of the organization the fixes change: an MCP app whose tools the stamp fix
 * makes ask always, and an app whose rules decide tools v1 did not list. Also each app that runs
 * a version deployed since the import (`deployedSince`), whose users may have changed its rules.
 * An integration imported as an app per connection (decision 33) has no `integration` row: its
 * apps were generated with both fixes, so none of them is planned.
 */
export const planStampedApps = (
  snapshot: V1Snapshot,
  source: Pick<V1Source, "tools" | "openApiOperations">,
  store: Pick<ImportStore, "find" | "deployedSince">,
) =>
  Effect.gen(function* () {
    const planned: {
      integration: IntegrationRow;
      app: AppId;
      always: readonly string[];
      unlisted: ReturnType<typeof unlistedChange>;
      floor: V1Floor;
      deployedSince: boolean;
    }[] = [];
    const since = yield* store.deployedSince(snapshot.tenant);
    for (const integration of snapshot.integrations) {
      const imported = yield* store.find("integration", integration.row_id);
      if (imported?.status !== "imported" || imported.v2_id === null) continue;
      const tools = yield* source.tools(snapshot.tenant, snapshot.subjects, integration.slug);
      const always =
        integration.plugin_id === "mcp" ? stampedAlways(snapshot, integration, tools) : [];
      const operations =
        integration.plugin_id === "openapi"
          ? (yield* source.openApiOperations(snapshot.tenant, integration.slug)).map(
              (operation) => operation.tool,
            )
          : undefined;
      const unlisted = unlistedChange(snapshot, integration, tools, operations);
      const deployedSince = since.has(integration.row_id);
      if (always.length > 0 || unlisted !== null || deployedSince)
        planned.push({
          integration,
          app: AppId.make(imported.v2_id),
          always,
          unlisted,
          floor: v1Floor(snapshot, integration, tools, operations),
          deployedSince,
        });
    }
    return planned;
  });

/**
 * The importer's context for a moved organization, as an import reads it: its v2 organization,
 * its imported members as the owner and subjects, and v1's rows for them. Undefined when it was
 * not imported; without a context when its v2 organization or owner is gone.
 */
export const movedOrganizationContext = (organization: string) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const store = makeImportStore(sql);
    const recorded = yield* store.find("organization", organization);
    if (recorded?.status !== "imported" || recorded.v2_id === null) return undefined;
    const target = yield* store.target(recorded.v2_id);
    const members = target === undefined ? [] : yield* importedMembers(sql, target.id);
    const owner = members.find((member) => member.role === "owner")?.v2;
    const [first, ...rest] = members.map((member) => member.v1);
    if (target === undefined || owner === undefined || first === undefined)
      return { v2Organization: recorded.v2_id, context: undefined };
    const subjects = [first, ...rest] as const;
    const source = yield* environment.source;
    const snapshot = yield* source.snapshot(
      organization,
      subjects,
      subjects.length > 1,
      allSnapshotTables,
    );
    const executor = yield* Effect.flatten(HostedExecutor);
    const context: ItemContext = {
      executor,
      connections: environment.connections,
      store,
      sql,
      source,
      snapshot,
      target: { id: target.id as ItemContext["target"]["id"], slug: target.slug },
      owner,
      users: new Map(members.map((member) => [member.v1, member.v2])),
      firstParty: firstPartyClients(executor, environment.v1FirstPartyClients).lookup,
    };
    return { v2Organization: recorded.v2_id, context };
  });

/**
 * Repair one moved organization, or plan its repair without writing (`apply` false). The members
 * are the imported v2 members whose user the import mapped, as the import read them.
 */
export const repairOrganization = (organization: string, apply: boolean) =>
  Effect.gen(function* () {
    const empty = { organization, applied: false, apps: [] };
    const moved = yield* movedOrganizationContext(organization);
    if (moved?.context === undefined)
      return {
        ...empty,
        v2Organization: moved?.v2Organization ?? null,
        status: "not_imported",
      } satisfies OrganizationRepair;
    const { context } = moved;
    const { snapshot, source, store, target, executor } = context;

    // v1's stamps and its rules for tools it did not list become the app's own.
    const apps: AppRepair[] = [];
    const appOwner = organizationOwner(target.id);
    for (const { integration, app, always, unlisted, floor } of yield* planStampedApps(
      snapshot,
      source,
      store,
    )) {
      const base = { integration: integrationLabel(integration), app, always, unlisted };
      const plan = integrationPlan(integration);
      if (!plan.ok) {
        apps.push({ ...base, decision: "failed", files: [], reason: plan.reason });
        continue;
      }
      const planned = appMethods(
        snapshot,
        context.firstParty,
        integration,
        yield* redundantFixed(context, integration),
      );
      const scoped = (files: Parameters<typeof scopeGeneratedPackage>[0]) =>
        scopeGeneratedPackage(files, target.slug, integrationLabel(integration));
      const generated = yield* Effect.all({
        after: generate(context, integration, plan.value, planned).pipe(
          Effect.flatMap((out) => scoped(out.files)),
        ),
        // What the importer generated before each fix: without either, and with the stamps only.
        before: Effect.all(
          [withoutStamps(source), source].map((earlier) =>
            generate(
              { ...context, source: earlier, unlistedRules: false },
              integration,
              plan.value,
              planned,
            ).pipe(Effect.flatMap((out) => scoped(out.files))),
          ),
        ),
      }).pipe(Effect.option);
      if (Option.isNone(generated)) {
        apps.push({
          ...base,
          decision: "failed",
          files: [],
          reason: "The importer no longer generates this app.",
        });
        continue;
      }
      const read = (version?: VersionId) =>
        executor.apps
          .source({
            owner: appOwner,
            versionOwner: appOwner,
            app,
            ...(version === undefined ? {} : { version }),
          })
          .pipe(Effect.map((found) => found.files));
      const deployed = yield* read().pipe(Effect.option);
      if (Option.isNone(deployed)) {
        apps.push({ ...base, decision: "removed", files: [] });
        continue;
      }
      // The versions the import deployed itself are an importer's output too, of an earlier
      // importer than this one.
      const imported = yield* Effect.forEach(
        yield* store.importedVersions(integration.row_id),
        (version) => read(VersionId.make(version)).pipe(Effect.option),
      ).pipe(Effect.map((found) => found.flatMap((files) => Option.toArray(files))));
      const merged = mergedFiles(
        deployed.value,
        generated.value.before,
        generated.value.after,
        imported,
      );
      // An app only deployed again since the import, whose fixes change nothing, keeps its rules.
      const fixed = always.length > 0 || unlisted !== null;
      if (merged.done || (merged.files !== undefined && !fixed)) {
        apps.push({ ...base, decision: "unchanged", source: "generated", files: [] });
        continue;
      }
      // An app whose users changed its approvals in v2 keeps them: their choice stands.
      if (
        merged.files === undefined &&
        approvalsChanged(deployed.value, [
          generated.value.after,
          ...generated.value.before,
          ...imported,
        ])
      ) {
        apps.push({
          ...base,
          decision: "kept",
          source: "edited",
          files: merged.blocked,
          reason: "Its users changed its approvals in v2, so they stay as they chose.",
        });
        continue;
      }
      const edited = merged.files === undefined ? flooredFiles(deployed.value, floor) : undefined;
      if (edited !== undefined && "reason" in edited) {
        apps.push({
          ...base,
          decision: "manual",
          source: "edited",
          files: merged.blocked,
          reason: edited.reason,
          v1: { asked: floor.asked, blocked: floor.blocked },
        });
        continue;
      }
      if (edited?.done === true) {
        apps.push({ ...base, decision: "unchanged", source: "edited", files: [] });
        continue;
      }
      const next =
        edited === undefined
          ? { files: merged.files, changed: merged.changed, source: "generated" as const }
          : { files: edited.files, changed: edited.changed, source: "edited" as const };
      const [index, ...others] = next.files ?? [];
      if (apply && index !== undefined) {
        const failure = yield* executor.apps
          .deploy({ owner: appOwner, app, files: [index, ...others] })
          .pipe(
            Effect.as(undefined),
            Effect.catchTags({
              VersionBuildFailed: (error) => Effect.succeed(`It did not build. ${error.message}`),
            }),
            sharedAppCreation,
            Effect.provideService(CurrentUserId, context.owner),
          );
        if (failure !== undefined) {
          apps.push({
            ...base,
            decision: "failed",
            source: next.source,
            files: next.changed,
            reason: failure,
          });
          continue;
        }
      }
      apps.push({ ...base, decision: "deploy", source: next.source, files: next.changed });
    }
    return {
      organization,
      v2Organization: target.id,
      applied: apply,
      status: apply ? "repaired" : "planned",
      apps,
    } satisfies OrganizationRepair;
  });

/** An earlier version of an imported app to run again, while the app still runs `expected`. */
export const AppRestore = Schema.Struct({
  app: AppId,
  version: VersionId,
  expected: VersionId,
});

export interface RestoredApp {
  readonly organization: string;
  readonly app: string;
  readonly version: string;
  /**
   * `restored`, or why not: the app runs another version than `expected` (`changed`, with the
   * version it runs), the app or version is not one of the organization's imported apps' (`not_found`),
   * or the organization has no live import (`not_imported`).
   */
  readonly status: "restored" | "changed" | "not_found" | "not_imported";
  readonly active?: string | null;
}

/**
 * Run an earlier version of one of a moved organization's imported apps again, as its users
 * would: the product's activation, which moves the app's version and nothing else. Only while it
 * still runs `expected`, so a version its users deployed since is never replaced. It gives an app
 * whose users changed its approvals in v2 back the version a repair replaced (decision 31).
 */
export const restoreApp = (organization: string, request: typeof AppRestore.Type) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const store = makeImportStore(sql);
    const base = { organization, app: request.app, version: request.version };
    const recorded = yield* store.find("organization", organization);
    const target =
      recorded?.status === "imported" && recorded.v2_id !== null
        ? yield* store.target(recorded.v2_id)
        : undefined;
    if (target === undefined) return { ...base, status: "not_imported" } satisfies RestoredApp;
    if (!(yield* store.importedApp(organization, request.app)))
      return { ...base, status: "not_found" } satisfies RestoredApp;
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps
      .activate({
        owner: organizationOwner(target.id),
        app: request.app,
        version: request.version,
        expectedVersion: request.expected,
      })
      .pipe(
        Effect.as({ ...base, status: "restored" } satisfies RestoredApp),
        Effect.catchTags({
          AppVersionChanged: (error) =>
            Effect.succeed({
              ...base,
              status: "changed",
              active: error.current,
            } satisfies RestoredApp),
          AppNotFound: () => Effect.succeed({ ...base, status: "not_found" } satisfies RestoredApp),
          VersionNotFound: () =>
            Effect.succeed({ ...base, status: "not_found" } satisfies RestoredApp),
        }),
      );
  });
