/** Named performance scenarios over one seeded perf target (a stage plus its receipt). */
import { Clock, Effect, Option, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { randomBytes } from "node:crypto";
import type { BrowserCookies } from "../../sdk/contracts.ts";
import {
  cookieHeader,
  mcpSession,
  PerfRequestFailed,
  productClient,
  type McpSession,
  type ProductClient,
  type Timed,
} from "./client.ts";
import { formatSpec } from "./emulator.ts";
import { openBrowser, type BrowserSession } from "./browser.ts";
import { fixtureId, type AppReceipt, type OrgReceipt, type Receipt } from "./seed.ts";
import { fixtureActors, stableUuid } from "./sessions.ts";
import type { StageControl } from "./stage.ts";

export interface Sample {
  readonly ok: boolean;
  readonly status: number;
  readonly clientMs: number;
  readonly serverMs?: number | undefined;
  readonly traceId?: string | undefined;
  readonly metrics?: Record<string, number>;
  readonly error?: string;
}

export type Group = "api" | "action" | "browser" | "mcp" | "toolcall" | "lifecycle";

export interface Scenario {
  readonly id: string;
  readonly group: Group;
  readonly description: string;
  readonly target: string;
  /** Samples discarded before measuring; zero for cold scenarios. */
  readonly warmup: number;
  readonly run: (target: PerfTarget) => Effect.Effect<Sample, PerfRequestFailed, never>;
}

/** Everything a scenario needs for one origin. Sessions refresh before their one-hour expiry. */
export interface PerfTarget {
  readonly label: string;
  readonly control: StageControl;
  readonly receipt: Receipt;
  readonly owner: (org: string) => Effect.Effect<ProductClient, PerfRequestFailed>;
  /** Owner of an extra fixture organization that is not in the receipt, created on first use. */
  readonly fixtureOwner: (
    id: string,
    label: string,
  ) => Effect.Effect<
    { readonly client: ProductClient; readonly organization: string },
    PerfRequestFailed
  >;
  readonly cookies: (org: string) => Effect.Effect<BrowserCookies, PerfRequestFailed>;
  readonly mcp: (org: string) => Effect.Effect<McpSession, PerfRequestFailed>;
  /** One browser per target, signed in as the dashboard org owner. */
  readonly browser: Effect.Effect<BrowserSession, PerfRequestFailed>;
  readonly org: (key: string) => OrgReceipt;
  readonly close: Effect.Effect<void>;
}

export const makeTarget = (label: string, control: StageControl, receipt: Receipt) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<HttpClient.HttpClient>();
    const sessions = new Map<
      string,
      { at: number; client: ProductClient; cookies: BrowserCookies; organization: string }
    >();
    const mcps = new Map<string, McpSession>();
    let browser: BrowserSession | undefined;
    const org = (key: string) => {
      const value = receipt.orgs[key];
      if (value === undefined) throw new Error(`Receipt has no organization ${key}; seed it first`);
      return value;
    };
    const fixtureSession = (id: string, label: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = sessions.get(id);
        if (cached !== undefined && now - cached.at < 40 * 60_000) return cached;
        const actors = yield* fixtureActors(control, id, label).pipe(
          Effect.mapError(
            (cause) =>
              new PerfRequestFailed({ operation: "fixture session", detail: String(cause) }),
          ),
        );
        const cookies = actors.actors.owner.cookies;
        const client = yield* productClient(control.origin, cookieHeader(cookies));
        const value = { at: now, client, cookies, organization: actors.organization.id };
        sessions.set(id, value);
        return value;
      }).pipe(Effect.provide(services));
    const session = (key: string) =>
      Effect.suspend(() => {
        const entry = org(key);
        return fixtureSession(entry.fixtureId, entry.label);
      });
    const target: PerfTarget = {
      label,
      control,
      receipt,
      org,
      owner: (key) => session(key).pipe(Effect.map((value) => value.client)),
      fixtureOwner: (id, label) =>
        fixtureSession(id, label).pipe(
          Effect.map(({ client, organization }) => ({ client, organization })),
        ),
      cookies: (key) => session(key).pipe(Effect.map((value) => value.cookies)),
      mcp: (key) =>
        Effect.gen(function* () {
          const cached = mcps.get(key);
          if (cached !== undefined && !cached.lost()) return cached;
          // A lost session failed its sample; later samples reconnect like a spec client.
          if (cached !== undefined) yield* cached.close.pipe(Effect.ignore);
          const entry = org(key);
          const opened = yield* mcpSession(control.origin, entry.pat, entry.organization.id);
          mcps.set(key, opened);
          return opened;
        }),
      browser: Effect.gen(function* () {
        if (browser !== undefined) return browser;
        const cookies = (yield* session(dashboardOrg)).cookies;
        browser = yield* openBrowser(control.origin, cookies);
        return browser;
      }),
      close: Effect.gen(function* () {
        for (const opened of mcps.values()) yield* opened.close.pipe(Effect.ignore);
        mcps.clear();
        if (browser !== undefined) yield* browser.close;
        browser = undefined;
      }),
    };
    return target;
  });

const fromTimed = (response: Timed, metrics?: Record<string, number>): Sample => ({
  ok: response.status >= 200 && response.status < 300,
  status: response.status,
  clientMs: response.clientMs,
  serverMs: response.serverMs,
  traceId: response.traceId,
  ...(metrics === undefined ? {} : { metrics }),
  ...(response.status >= 300 ? { error: JSON.stringify(response.body).slice(0, 200) } : {}),
});

export const dashboardOrg = "a8f";
export const primaryApp = (entry: OrgReceipt) =>
  entry.apps.find((app) => app.accounts.length > 0) ?? entry.apps[0]!;
export const primaryAccount = (entry: OrgReceipt) =>
  entry.apps.flatMap((app) => app.accounts)[0] ?? "missing";

const org = (o: OrgReceipt) => `/api/organizations/${o.organization.id}`;
const app = (o: OrgReceipt) => `${org(o)}/apps/${primaryApp(o).id}`;
/** Dashboard reads observed in production traffic, parameterised by the dashboard org. */
const apiRoutes: readonly (readonly [string, string, (o: OrgReceipt) => string])[] = [
  ["inventory", "{org}/inventory", (o) => `${org(o)}/inventory`],
  ["resources", "{org}/resources", (o) => `${org(o)}/resources`],
  ["apps", "{org}/apps", (o) => `${org(o)}/apps`],
  ["access", "{org}/access", (o) => `${org(o)}/access`],
  ["groups", "{org}/groups", (o) => `${org(o)}/groups`],
  ["billing", "{org}/billing", (o) => `${org(o)}/billing`],
  ["app-publications", "{org}/app-publications", (o) => `${org(o)}/app-publications`],
  ["removal", "{org}/removal", (o) => `${org(o)}/removal`],
  ["scheduled-runs", "{org}/scheduled-runs", (o) => `${org(o)}/scheduled-runs`],
  ["app", "{app}", (o) => app(o)],
  ["app.profiles", "{app}/profiles", (o) => `${app(o)}/profiles`],
  ["app.access", "{app}/access", (o) => `${app(o)}/access`],
  ["app.authoring", "{app}/authoring", (o) => `${app(o)}/authoring`],
  ["app.ui", "{app}/ui", (o) => `${app(o)}/ui`],
  ["app.webhooks", "{app}/webhooks", (o) => `${app(o)}/webhooks`],
  [
    "app.skills",
    "{app}/skills?profile=",
    (o) => `${app(o)}/skills?profile=${primaryApp(o).profile}`,
  ],
  [
    "app.workflows",
    "{app}/workflows?profile=",
    (o) => `${app(o)}/workflows?profile=${primaryApp(o).profile}`,
  ],
  ["app.tools", "{app}/tools?profile=", (o) => `${app(o)}/tools?profile=${primaryApp(o).profile}`],
  [
    "app.tools.index",
    "{app}/tools/index?profile=",
    (o) => `${app(o)}/tools/index?profile=${primaryApp(o).profile}`,
  ],
  [
    "app.tool",
    "{app}/tools/{tool}?profile=",
    (o) => `${app(o)}/tools/queries.list_account_0000?profile=${primaryApp(o).profile}`,
  ],
  ["app.workspace", "{app}/workspace", (o) => `${app(o)}/workspace`],
  ["app.workspace.display", "{app}/workspace/display", (o) => `${app(o)}/workspace/display`],
  ["app.source", "{app}/source", (o) => `${app(o)}/source`],
  ["app.deployments", "{app}/deployments", (o) => `${app(o)}/deployments`],
  ["app.history", "{app}/history", (o) => `${app(o)}/history`],
  [
    "app.skill-bundle",
    "{app}/skill-bundle?profile=",
    (o) => `${app(o)}/skill-bundle?profile=${primaryApp(o).profile}`,
  ],
  ["app.schedules", "{app}/schedules", (o) => `${app(o)}/schedules`],
  [
    "app.webhook-definitions",
    "{app}/webhook-definitions?profile=",
    (o) => `${app(o)}/webhook-definitions?profile=${primaryApp(o).profile}`,
  ],
  [
    "app.schedule-definitions",
    "{app}/schedules/definitions?profile=",
    (o) => `${app(o)}/schedules/definitions?profile=${primaryApp(o).profile}`,
  ],
  ["account", "{org}/accounts/{account}", (o) => `${org(o)}/accounts/${primaryAccount(o)}`],
  [
    "account.access",
    "{org}/accounts/{account}/access",
    (o) => `${org(o)}/accounts/${primaryAccount(o)}/access`,
  ],
  ["catalog", "/api/catalog", () => `/api/catalog`],
  ["registry.apps", "/api/registry/apps", () => `/api/registry/apps`],
  ["auth.get-session", "/api/auth/get-session", () => `/api/auth/get-session`],
  ["auth.organization.list", "/api/auth/organization/list", () => `/api/auth/organization/list`],
  [
    "auth.list-members",
    "/api/auth/organization/list-members",
    (o) => `/api/auth/organization/list-members?organizationId=${o.organization.id}`,
  ],
  [
    "auth.list-invitations",
    "/api/auth/organization/list-invitations",
    (o) => `/api/auth/organization/list-invitations?organizationId=${o.organization.id}`,
  ],
  ["auth.api-key.list", "/api/auth/api-key/list", () => `/api/auth/api-key/list`],
];

const apiScenarios: Scenario[] = apiRoutes.map(([name, shown, path]) => ({
  id: `api.${name}`,
  group: "api",
  description: `GET ${shown.replace("{org}", "/api/organizations/{org}").replace("{app}", "/api/organizations/{org}/apps/{app}")} as owner (${dashboardOrg} org)`,
  target: "< 300 ms warm",
  warmup: 2,
  run: (target) =>
    target.owner(dashboardOrg).pipe(
      Effect.flatMap((client) => client.request("GET", path(target.org(dashboardOrg)))),
      Effect.map((response) => fromTimed(response)),
    ),
}));

/**
 * App-detail tabs backed by app evaluation, on an account-bound MCP app from the org whose
 * upstreams have production latency. The imported app's factory does not wait on its upstream,
 * so these reads measure evaluation of an app in that org, not a slow factory.
 */
const slowOrg = "a8s";
const slowApp = (o: OrgReceipt) =>
  o.apps.find((entry) => entry.kind === "mcp" && entry.accounts.length > 0) ?? primaryApp(o);
const slowTabs: readonly (readonly [string, (o: OrgReceipt) => string])[] = [
  ["skills", (o) => `skills?profile=${slowApp(o).profile}`],
  ["skill-bundle", (o) => `skill-bundle?profile=${slowApp(o).profile}`],
  ["workflows", (o) => `workflows?profile=${slowApp(o).profile}`],
  ["webhook-definitions", (o) => `webhook-definitions?profile=${slowApp(o).profile}`],
];
const slowTabScenarios: Scenario[] = slowTabs.map(([name, path]) => ({
  id: `api.slow.app.${name}`,
  group: "api",
  description: `GET {app}/${name} as owner (${slowOrg} org, account-bound imported MCP app; its factory does not await the upstream)`,
  target: "< 300 ms warm",
  warmup: 2,
  run: (target) =>
    target.owner(slowOrg).pipe(
      Effect.flatMap((client) => {
        const entry = target.org(slowOrg);
        return client.request("GET", `${org(entry)}/apps/${slowApp(entry).id}/${path(entry)}`);
      }),
      Effect.map((response) => fromTimed(response)),
    ),
}));

/**
 * An app whose factory awaits a remote catalog before it declares skills and workflows, as
 * generated catalogs do in production. The emulated document takes the production p50
 * discovery latency (512 ms) on every load. Its own fixture organization keeps it out of the
 * seeded orgs; setup (deploy, profile, account) runs once per target and is not measured.
 */
const factoryOrg = "decl";
const factoryAppName = "Perf slow factory";
const factorySource = (emulator: string) => {
  const catalog = `${emulator}/openapi/${formatSpec({ tools: 5, listMs: 512, key: "slowfactory" })}/openapi.json`;
  return `import {defineApp,defineProvider,secrets,query,workflow,object,string} from "apps";
const service=defineProvider({name:"Slow catalog",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const noop=workflow({input:object({})},async()=>null);
export default defineApp({accounts:{service}},async ctx=>{
  const document=await (await ctx.fetch(${JSON.stringify(catalog)},{headers:{"x-api-key":ctx.accounts.service.fields.token}})).json();
  const operations=Object.keys(document.paths??{}).map(path=>path.split("/").pop());
  return {
    queries:{ping:query({input:object({})},async()=>"pong")},
    workflows:Object.fromEntries(operations.map(name=>["sync_"+name,noop])),
    skills:[{name:"catalog-guide",description:"Operations: "+operations.join(", "),files:[{path:"SKILL.md",content:"---\\nname: catalog-guide\\ndescription: Remote catalog guide\\n---\\n# Catalog"}]}],
  };
});`;
};
const FactoryInventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  profiles: Schema.Array(Schema.Struct({ id: Schema.String, app: Schema.String })),
});
const Identified = Schema.Struct({ id: Schema.String });
const prepared = new Map<string, { readonly path: string; readonly profile: string }>();
const slowFactory = (target: PerfTarget) =>
  Effect.gen(function* () {
    const { client, organization } = yield* target.fixtureOwner(
      fixtureId(target.receipt.seed, factoryOrg),
      `perf ${factoryOrg}`,
    );
    const known = prepared.get(target.label);
    if (known !== undefined) return { client, ...known };
    const root = `/api/organizations/${organization}`;
    const ok = (operation: string) => (response: Timed) =>
      response.status === 200
        ? Effect.succeed(response.body)
        : Effect.fail(
            new PerfRequestFailed({
              operation,
              status: response.status,
              detail: JSON.stringify(response.body).slice(0, 300),
            }),
          );
    const decode = <A>(schema: Schema.Codec<A, unknown>) =>
      Effect.flatMap((value: unknown) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(
            () => new PerfRequestFailed({ operation: "decode", detail: "unexpected body" }),
          ),
        ),
      );
    const inventory = yield* client
      .request("GET", `${root}/inventory`)
      .pipe(Effect.flatMap(ok("inventory")), decode(FactoryInventory));
    const existing = inventory.apps.find((entry) => entry.name === factoryAppName);
    const existingProfile = inventory.profiles.find((entry) => entry.app === existing?.id);
    if (existing !== undefined && existingProfile !== undefined) {
      const value = { path: `${root}/apps/${existing.id}`, profile: existingProfile.id };
      prepared.set(target.label, value);
      return { client, ...value };
    }
    const deployed =
      existing ??
      (yield* client
        .request("POST", `${root}/apps/deploy`, {
          name: factoryAppName,
          files: [{ path: "index.ts", content: factorySource(target.receipt.emulator) }],
        })
        .pipe(Effect.flatMap(ok("deploy slow factory")), decode(Identified)));
    const path = `${root}/apps/${deployed.id}`;
    const profile = yield* client
      .request("POST", `${path}/profiles`, {
        accounts: {},
        idempotencyKey: stableUuid(`${deployed.id}:profile`),
      })
      .pipe(Effect.flatMap(ok("slow factory profile")), decode(Identified));
    const connection = yield* client
      .request("POST", `${path}/connections`, {
        profile: profile.id,
        requirement: "service",
        destination: { kind: "personal" },
      })
      .pipe(Effect.flatMap(ok("slow factory connection")), decode(Identified));
    yield* client
      .request("POST", `${root}/connections/${connection.id}/submit`, {
        method: "key",
        label: "Synthetic slow factory",
        fields: { token: "synthetic-perf-slowfactory" },
      })
      .pipe(Effect.flatMap(ok("slow factory account")));
    const value = { path, profile: profile.id };
    prepared.set(target.label, value);
    return { client, ...value };
  });
const factoryTabs = ["skills", "skill-bundle", "workflows"] as const;
const factoryScenarios: Scenario[] = factoryTabs.map((name) => ({
  id: `api.factory.app.${name}`,
  group: "api",
  description: `GET {app}/${name} as owner (${factoryOrg} org, account-bound app whose factory awaits a 512 ms remote catalog)`,
  target: "< 300 ms warm",
  warmup: 2,
  run: (target) =>
    slowFactory(target).pipe(
      Effect.flatMap((app) =>
        app.client.request("GET", `${app.path}/${name}?profile=${app.profile}`),
      ),
      Effect.map((response) => fromTimed(response)),
    ),
}));

const actionScenarios: Scenario[] = [
  {
    id: "action.profile.update",
    group: "action",
    description:
      "PATCH a profile with its current account selection (revision read first, unmeasured)",
    target: "< 300 ms warm",
    warmup: 2,
    run: (target) =>
      Effect.gen(function* () {
        const entry = target.org(dashboardOrg);
        const selected = primaryApp(entry);
        const client = yield* target.owner(dashboardOrg);
        const path = `${app(entry)}/profiles/${selected.profile}`;
        const current = yield* client.request("GET", path);
        const revision = Schema.decodeUnknownOption(Schema.Struct({ revision: Schema.Number }))(
          current.body,
        );
        if (revision._tag === "None") return fromTimed(current);
        return fromTimed(
          yield* client.request("PATCH", path, {
            expectedRevision: revision.value.revision,
            accounts: selected.accounts.length ? { service: selected.accounts } : {},
          }),
        );
      }),
  },
];

/** Pull the emulator-reported processing time out of any tool result shape. */
const upstreamOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const emulator = record.emulator;
  if (emulator !== null && typeof emulator === "object") {
    const ms = (emulator as Record<string, unknown>).processingMs;
    if (typeof ms === "number") return ms;
  }
  for (const key of ["structuredContent", "body", "data", "value", "result"]) {
    const nested = upstreamOf(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

const toolPath = (entry: AppReceipt) =>
  `tools[${JSON.stringify(entry.slug)}].profiles[${JSON.stringify(entry.profile)}].queries.list_account_0000`;
const toolInput = (entry: AppReceipt) =>
  entry.accounts.length > 0
    ? `{ accountId: ${JSON.stringify(entry.accounts[0])}, input: {} }`
    : "{}";

/** Execute code: search the whole catalog, then call one tool and time it inside the sandbox. */
export const executeCode = (entry: AppReceipt, calls: number) => `
const found = await tools.search({ query: "list account", limit: 5 });
const timings = [];
let last;
for (let i = 0; i < ${calls}; i++) {
  const at = Date.now();
  last = await ${toolPath(entry)}(${toolInput(entry)});
  timings.push(Date.now() - at);
}
const up = (v) => v && typeof v === "object" ? (v.emulator && typeof v.emulator.processingMs === "number" ? v.emulator.processingMs : (up(v.structuredContent) ?? up(v.body) ?? up(v.data) ?? up(v.result))) : undefined;
return { matches: found.items.length, timings, upstreamMs: up(last) ?? null };`;

const ExecuteResult = Schema.Struct({
  status: Schema.String,
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(
      Schema.Struct({
        matches: Schema.Number,
        timings: Schema.Array(Schema.Number),
        upstreamMs: Schema.NullOr(Schema.Number),
      }),
    ),
  }),
  unavailableApps: Schema.optional(Schema.Array(Schema.Unknown)),
});

const executeSample = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    const call = yield* session.callTool("execute", { code });
    const exchange = call.exchanges.find((entry) => entry.method === "tools/call");
    const decoded = Schema.decodeUnknownOption(ExecuteResult)(call.result.structuredContent);
    const base = {
      status: exchange?.status ?? 0,
      clientMs: call.clientMs,
      serverMs: exchange?.serverMs,
      traceId: exchange?.traceId,
    };
    if (
      decoded._tag === "None" ||
      !decoded.value.execution.ok ||
      decoded.value.execution.value === undefined
    )
      return {
        ...base,
        ok: false,
        error: JSON.stringify(call.result.structuredContent ?? call.result.content).slice(0, 300),
      } satisfies Sample;
    const value = decoded.value.execution.value;
    const callMs = value.timings.reduce((a, b) => a + b, 0) / Math.max(1, value.timings.length);
    const upstream = value.upstreamMs ?? 0;
    return {
      ...base,
      ok: true,
      metrics: {
        matches: value.matches,
        unavailableApps: decoded.value.unavailableApps?.length ?? 0,
        callMs,
        upstreamMs: upstream,
        executorAddedMs: callMs - upstream,
        firstCallMs: value.timings[0] ?? 0,
      },
    } satisfies Sample;
  });

const executeScenarios: Scenario[] = (["1", "8", "24"] as const).flatMap((size) =>
  (["f", "s"] as const).flatMap((speed): Scenario[] => {
    const key = `a${size}${speed}`;
    const label = speed === "f" ? "fast" : "slow";
    const code = (target: PerfTarget) => executeCode(target.org(key).apps[0]!, 1);
    return [
      {
        id: `mcp.execute.${size}.${label}.warm`,
        group: "mcp",
        description: `MCP execute (catalog search + 1 tool call) in a ${size}-app org with ${label} upstreams, reused session`,
        target: "< 300 ms warm + upstream",
        warmup: 2,
        run: (target) =>
          target.mcp(key).pipe(Effect.flatMap((session) => executeSample(session, code(target)))),
      },
      {
        id: `mcp.execute.${size}.${label}.cold`,
        group: "mcp",
        description: `First MCP execute in a new session (${size} apps, ${label} upstreams); session open excluded`,
        target: "minimise; report",
        warmup: 0,
        run: (target) =>
          Effect.gen(function* () {
            const entry = target.org(key);
            const session = yield* mcpSession(
              target.control.origin,
              entry.pat,
              entry.organization.id,
            );
            const sample = yield* executeSample(session, code(target));
            yield* session.close.pipe(Effect.ignore);
            return sample;
          }),
      },
    ];
  }),
);

const sessionScenarios: Scenario[] = [
  {
    id: "mcp.session.open",
    group: "mcp",
    description: "Open an MCP session (initialize + initialized) with a PAT",
    target: "< 300 ms warm",
    warmup: 2,
    run: (target) =>
      Effect.gen(function* () {
        const entry = target.org("a1f");
        const session = yield* mcpSession(target.control.origin, entry.pat, entry.organization.id);
        const init = session.exchanges.find((exchange) => exchange.method === "initialize");
        yield* session.close.pipe(Effect.ignore);
        return {
          ok: true,
          status: init?.status ?? 0,
          clientMs: session.openMs,
          serverMs: init?.serverMs,
          traceId: init?.traceId,
        } satisfies Sample;
      }),
  },
  {
    id: "mcp.session.close",
    group: "mcp",
    description: "Close an MCP session (DELETE /mcp)",
    target: "< 300 ms warm",
    warmup: 2,
    run: (target) =>
      Effect.gen(function* () {
        const entry = target.org("a1f");
        const session = yield* mcpSession(target.control.origin, entry.pat, entry.organization.id);
        const before = session.exchanges.length;
        const ms = yield* session.close;
        const exchange = session.exchanges
          .slice(before)
          .find((candidate) => candidate.httpMethod === "DELETE");
        return {
          // Recorded as served when the product answers without a server error (this build: 405).
          ok: exchange !== undefined && exchange.status < 500,
          status: exchange?.status ?? 0,
          clientMs: ms,
          serverMs: exchange?.serverMs,
          traceId: exchange?.traceId,
        } satisfies Sample;
      }),
  },
];

const callApps = [
  ["mcp", (entry: AppReceipt) => entry.kind === "mcp" && !entry.auth],
  ["mcp-account", (entry: AppReceipt) => entry.kind === "mcp" && entry.auth],
  ["openapi", (entry: AppReceipt) => entry.kind === "openapi"],
] as const;
const callApp = (target: PerfTarget, match: (entry: AppReceipt) => boolean) => {
  const found = target.org("call").apps.find(match);
  if (found === undefined) throw new Error("Receipt is missing a tool-call app");
  return found;
};

const toolcallScenarios: Scenario[] = [
  ...callApps.map(([name, match]): Scenario => ({
    id: `toolcall.rest.${name}`,
    group: "toolcall",
    description: `POST apps/{app}/tools/call on a zero-latency ${name} upstream; executorAddedMs = server - upstream`,
    target: "executor-added < 10 ms",
    warmup: 3,
    run: (target) =>
      Effect.gen(function* () {
        const entry = target.org("call");
        const selected = callApp(target, match);
        const client = yield* target.owner("call");
        const response = yield* client.request(
          "POST",
          `${org(entry)}/apps/${selected.id}/tools/call`,
          {
            profile: selected.profile,
            tool: "queries.list_account_0000",
            input: selected.accounts.length ? { accountId: selected.accounts[0], input: {} } : {},
          },
        );
        const upstream = upstreamOf(response.body) ?? 0;
        return fromTimed(response, {
          upstreamMs: upstream,
          executorAddedMs: (response.serverMs ?? response.clientMs) - upstream,
        });
      }),
  })),
  ...callApps.map(([name, match]): Scenario => ({
    id: `toolcall.execute.${name}`,
    group: "toolcall",
    description: `MCP execute making 5 sequential calls to a zero-latency ${name} upstream; callMs is timed inside the sandbox, executorAddedMs = callMs - upstream`,
    target: "executor-added < 10 ms per call",
    warmup: 2,
    run: (target) =>
      target
        .mcp("call")
        .pipe(
          Effect.flatMap((session) =>
            executeSample(session, executeCode(callApp(target, match), 5)),
          ),
        ),
  })),
];

const lifecycleSource = (marker: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, string } from "apps";
export default defineApp({ accounts: {} }, async () => ({ queries: {
  ping: query({ description: "Perf lifecycle ping ${marker}", input: object({ value: string() }) }, async (_, input) => ({ value: input.value, marker: ${JSON.stringify(marker)} })),
} }));
`,
  },
];

const Created = Schema.Struct({ id: Schema.String });
const removeCreated = (client: ProductClient, entry: OrgReceipt, response: Timed) => {
  const created = Schema.decodeUnknownOption(Created)(response.body);
  return created._tag === "Some"
    ? client.request("DELETE", `${org(entry)}/apps/${created.value.id}`).pipe(Effect.ignore)
    : Effect.void;
};
const lifecycleScenarios: Scenario[] = [
  {
    id: "app.import.mcp",
    group: "lifecycle",
    description:
      "POST apps/import of a new 50-tool emulator MCP server (uncached URL), then delete (unmeasured)",
    target: "minimise; report",
    warmup: 1,
    run: (target) =>
      Effect.gen(function* () {
        const entry = target.org("call");
        const client = yield* target.owner("call");
        const key = `life${randomBytes(6).toString("hex")}`;
        const response = yield* client.request("POST", `${org(entry)}/apps/import`, {
          source: {
            kind: "mcp",
            name: `Perf import ${key}`,
            url: `${target.receipt.emulator}/mcp/${formatSpec({ tools: 50, listMs: 30, key })}/mcp`,
          },
        });
        yield* removeCreated(client, entry, response);
        return fromTimed(response);
      }),
  },
  {
    id: "app.deploy.new",
    group: "lifecycle",
    description: "POST apps/deploy of a new one-query authored app, then delete (unmeasured)",
    target: "minimise; report",
    warmup: 1,
    run: (target) =>
      Effect.gen(function* () {
        const entry = target.org("call");
        const client = yield* target.owner("call");
        const marker = randomBytes(6).toString("hex");
        const response = yield* client.request("POST", `${org(entry)}/apps/deploy`, {
          name: `Perf deploy ${marker}`,
          files: lifecycleSource(marker),
        });
        yield* removeCreated(client, entry, response);
        return fromTimed(response);
      }),
  },
  {
    id: "app.deploy.update",
    group: "lifecycle",
    description: "POST apps/{app}/deploy with edited source for an existing authored app",
    target: "minimise; report",
    warmup: 1,
    run: (target) =>
      Effect.gen(function* () {
        const entry = target.org("call");
        const client = yield* target.owner("call");
        const listed = Schema.decodeUnknownOption(
          Schema.Struct({
            apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
          }),
        )((yield* client.request("GET", `${org(entry)}/inventory`)).body);
        if (listed._tag === "None")
          return yield* new PerfRequestFailed({ operation: "inventory", detail: "unreadable" });
        let id = listed.value.apps.find((candidate) => candidate.name === "Perf redeploy")?.id;
        if (id === undefined) {
          const created = yield* client.request("POST", `${org(entry)}/apps/deploy`, {
            name: "Perf redeploy",
            files: lifecycleSource("initial"),
          });
          const decoded = Schema.decodeUnknownOption(Created)(created.body);
          if (decoded._tag === "None") return fromTimed(created);
          id = decoded.value.id;
        }
        return fromTimed(
          yield* client.request("POST", `${org(entry)}/apps/${id}/deploy`, {
            files: lifecycleSource(randomBytes(6).toString("hex")),
          }),
        );
      }),
  },
];

const pages: readonly (readonly [string, string, (o: OrgReceipt) => string])[] = [
  ["apps", "/org/{slug}/apps", (o) => `/org/${o.organization.slug}/apps`],
  ["app", "/org/{slug}/apps/{app}", (o) => `/org/${o.organization.slug}/apps/${primaryApp(o).id}`],
  ["accounts", "/org/{slug}/accounts", (o) => `/org/${o.organization.slug}/accounts`],
  [
    "account",
    "/org/{slug}/accounts/{account}",
    (o) => `/org/${o.organization.slug}/accounts/${primaryAccount(o)}`,
  ],
  ["groups", "/org/{slug}/groups", (o) => `/org/${o.organization.slug}/groups`],
  ["add", "/org/{slug}/apps/add", (o) => `/org/${o.organization.slug}/apps/add`],
  ["approvals", "/org/{slug}/approvals", (o) => `/org/${o.organization.slug}/approvals`],
  ["organization", "/org/{slug}/organization", (o) => `/org/${o.organization.slug}/organization`],
  ["api-keys", "/org/{slug}/api-keys", (o) => `/org/${o.organization.slug}/api-keys`],
];
const uiSample = (timing: import("./browser.ts").UiTiming): Sample => ({
  ok: timing.failed === 0,
  status: timing.failed === 0 ? 200 : 0,
  clientMs: timing.ms,
  serverMs: timing.maxServerMs,
  traceId: timing.slowestTraceId,
  metrics: { requests: timing.requests, apiRequests: timing.apiRequests },
  ...(timing.failed === 0 ? {} : { error: `${timing.failed} requests failed` }),
});
const browserScenarios: Scenario[] = [
  ...pages.map(([name, shown, path]): Scenario => ({
    id: `ui.load.${name}`,
    group: "browser",
    description: `Full page load of ${shown} until its requests settle (server = slowest API handler)`,
    target: "< 300 ms warm (API); report document load",
    warmup: 1,
    run: (target) =>
      target.browser.pipe(
        Effect.flatMap((browser) => browser.load(path(target.org(dashboardOrg)))),
        Effect.map(uiSample),
      ),
  })),
  ...pages.map(([name, shown, path]): Scenario => ({
    id: `ui.nav.${name}`,
    group: "browser",
    description: `Client-side navigation to ${shown} from the apps list (link click or router history), until requests settle`,
    target: "< 300 ms warm",
    warmup: 1,
    run: (target) =>
      Effect.gen(function* () {
        const browser = yield* target.browser;
        const entry = target.org(dashboardOrg);
        const from = pages[name === "apps" ? 1 : 0]![2](entry);
        yield* browser.load(from);
        return uiSample(yield* browser.navigate(path(entry)));
      }),
  })),
  {
    id: "ui.action.search-apps",
    group: "browser",
    description: "Type into the apps list search and wait for the filtered list to settle",
    target: "< 300 ms warm",
    warmup: 1,
    run: (target) =>
      Effect.gen(function* () {
        const browser = yield* target.browser;
        yield* browser.load(pages[0]![2](target.org(dashboardOrg)));
        return uiSample(
          yield* browser.measure((page) =>
            page
              .getByRole("searchbox")
              .or(page.getByPlaceholder(/search/i))
              .first()
              .fill(`Perf ${Math.random() < 0.5 ? "MCP" : "API"}`),
          ),
        );
      }),
  },
];

const FailedExecution = Schema.Struct({
  status: Schema.String,
  execution: Schema.Struct({
    ok: Schema.Boolean,
    error: Schema.optional(
      Schema.Struct({
        kind: Schema.String,
        message: Schema.String,
        response: Schema.optional(Schema.Struct({ code: Schema.String })),
      }),
    ),
    logs: Schema.optional(Schema.Array(Schema.String)),
    toolCalls: Schema.Array(
      Schema.Struct({ name: Schema.String, outcome: Schema.optional(Schema.String) }),
    ),
  }),
  unavailableApps: Schema.optional(
    Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
  ),
});

/** Run one execute whose failure is the expected outcome and score what it reported. */
const failureSample = (
  target: PerfTarget,
  program: Effect.Effect<string, PerfRequestFailed>,
  score: (result: typeof FailedExecution.Type) => Record<string, number>,
) =>
  Effect.gen(function* () {
    const code = yield* program;
    const session = yield* target.mcp("err");
    const call = yield* session.callTool("execute", { code });
    const exchange = call.exchanges.find((entry) => entry.method === "tools/call");
    const decoded = Schema.decodeUnknownOption(FailedExecution)(call.result.structuredContent);
    const base = {
      status: exchange?.status ?? 0,
      clientMs: call.clientMs,
      serverMs: exchange?.serverMs,
      traceId: exchange?.traceId,
    };
    if (Option.isNone(decoded) || decoded.value.status !== "completed")
      return {
        ...base,
        ok: false,
        error: JSON.stringify(call.result.structuredContent ?? call.result.content).slice(0, 300),
      } satisfies Sample;
    const error = decoded.value.execution.error;
    return {
      ...base,
      ok: true,
      metrics: {
        unknownTool: error?.kind === "UnknownTool" ? 1 : 0,
        executionFailure: error?.kind === "ExecutionFailure" ? 1 : 0,
        ...score(decoded.value),
      },
    } satisfies Sample;
  });
const errApp = (target: PerfTarget, name: string) =>
  Effect.fromNullishOr(target.org("err").apps.find((app) => app.name === name)).pipe(
    Effect.mapError(
      () =>
        new PerfRequestFailed({
          operation: "receipt",
          detail: `Receipt has no ${name}; seed --only err first`,
        }),
    ),
  );
const errTool = (target: PerfTarget, name: string) =>
  errApp(target, name).pipe(
    Effect.map((entry) =>
      entry.profile === ""
        ? `tools[${JSON.stringify(entry.slug)}].queries.list_account_0000`
        : `tools[${JSON.stringify(entry.slug)}].profiles[${JSON.stringify(entry.profile)}].queries.list_account_0000`,
    ),
  );

const failureScenarios: Scenario[] = [
  {
    id: "exec.timeout.report",
    group: "mcp",
    description:
      "Execute that completes one call, logs, then calls a 45 s tool; the 30 s budget must report the completed call and the log",
    target: "result at the 30 s budget with calls and logs",
    warmup: 0,
    run: (target) =>
      failureSample(
        target,
        Effect.all([errTool(target, "Perf err fast"), errTool(target, "Perf err slow")]).pipe(
          Effect.map(
            ([fast, slow]) => `const first = await ${fast}({});
console.log("first call finished");
await ${slow}({});
return "unreachable";`,
          ),
        ),
        ({ execution }) => ({
          timeoutExceeded: execution.error?.kind === "TimeoutExceeded" ? 1 : 0,
          logsReported: (execution.logs ?? []).some((line) => line.includes("first call finished"))
            ? 1
            : 0,
          succeededReported: execution.toolCalls.filter((call) => call.outcome === "success")
            .length,
        }),
      ),
  },
  {
    id: "exec.unavailable.account",
    group: "mcp",
    description:
      "Execute calling a tool of an app whose required account is not selected; the call must name the missing account",
    target: "fast, curated AccountRequired instead of UnknownTool",
    warmup: 1,
    run: (target) =>
      failureSample(
        target,
        errTool(target, "Perf err keyed").pipe(Effect.map((tool) => `return await ${tool}({});`)),
        ({ execution }) => ({
          curated: execution.error?.response?.code === "AccountRequired" ? 1 : 0,
        }),
      ),
  },
  {
    id: "exec.refused.mcp",
    group: "mcp",
    description:
      "Execute calling a tool of an app whose MCP server rejects the connection; the call must name the refusal",
    target: "fast, names the MCP refusal instead of a generic definition failure",
    warmup: 1,
    run: (target) =>
      failureSample(
        target,
        errTool(target, "Perf err moved").pipe(Effect.map((tool) => `return await ${tool}({});`)),
        ({ execution, unavailableApps }) => ({
          curated:
            execution.error?.message.includes("refused the request") === true &&
            (unavailableApps ?? []).some((app) => app.reason.includes("refused the request"))
              ? 1
              : 0,
        }),
      ),
  },
  {
    id: "exec.timeout.cleanup",
    group: "mcp",
    description:
      "Execute that leaves a cache refresh running, logs, then calls a 45 s tool; the timeout must be reported as one, with calls and logs, although closing the run is slow",
    target: "TimeoutExceeded at the 30 s budget with calls and logs",
    warmup: 0,
    run: (target) =>
      failureSample(
        target,
        Effect.all([errApp(target, "Perf err cleanup"), errTool(target, "Perf err slow")]).pipe(
          Effect.map(([refresh, slow]) => {
            const app = `tools[${JSON.stringify(refresh.slug)}].queries`;
            const key = JSON.stringify(randomBytes(8).toString("hex"));
            // The pause makes the 30 s refresh end more than a second after the budget.
            return `await ${app}.pause({});
await ${app}.seed({ key: ${key} });
await ${app}.stale({ key: ${key} });
console.log("refresh started");
await ${slow}({});
return "unreachable";`;
          }),
        ),
        ({ execution }) => ({
          logsReported: (execution.logs ?? []).includes("refresh started") ? 1 : 0,
          succeededReported: execution.toolCalls.filter((call) => call.outcome === "success")
            .length,
        }),
      ),
  },
  {
    id: "exec.refresh.return",
    group: "mcp",
    description:
      "Execute whose cached read starts a 30 s background refresh; the program's result must not wait for it",
    target: "returns the program's value at once, not a timeout",
    warmup: 1,
    run: (target) =>
      failureSample(
        target,
        errApp(target, "Perf err refresh").pipe(
          Effect.map((entry) => {
            const app = `tools[${JSON.stringify(entry.slug)}].queries`;
            const key = JSON.stringify(randomBytes(8).toString("hex"));
            return `await ${app}.seed({ key: ${key} });
const value = await ${app}.stale({ key: ${key} });
console.log("served", value);
return value;`;
          }),
        ),
        ({ execution }) => ({
          returned: execution.ok && (execution.logs ?? []).includes("served seed") ? 1 : 0,
        }),
      ),
  },
];

const Parked = Schema.Struct({ status: Schema.String, requestId: Schema.optional(Schema.String) });

/** Ask for an approval after a cached read left a refresh running, then decline it unmeasured. */
const approvalAfterRefresh: Scenario = {
  id: "exec.approval.refresh",
  group: "mcp",
  description:
    "Execute whose cached read starts a 30 s background refresh, then calls an approval-gated mutation; the approval must be requested at once",
  target: "approval-required within a few seconds, not a timeout",
  warmup: 1,
  run: (target) =>
    Effect.gen(function* () {
      const entry = yield* errApp(target, "Perf err approval");
      const app = `tools[${JSON.stringify(entry.slug)}]`;
      const key = JSON.stringify(randomBytes(8).toString("hex"));
      const session = yield* target.mcp("err");
      const call = yield* session.callTool("execute", {
        code: `await ${app}.queries.seed({ key: ${key} });
await ${app}.queries.stale({ key: ${key} });
return await ${app}.mutations.approved({});`,
      });
      const exchange = call.exchanges.find((entry) => entry.method === "tools/call");
      const parked = Schema.decodeUnknownOption(Parked)(call.result.structuredContent);
      const failed = Schema.decodeUnknownOption(FailedExecution)(call.result.structuredContent);
      const kind = Option.isSome(failed) ? failed.value.execution.error?.kind : undefined;
      // Parked runs hold an execution slot until they expire; release this one.
      if (Option.isSome(parked) && parked.value.requestId !== undefined)
        yield* session.callTool("resume", {
          requestId: parked.value.requestId,
          response: { action: "decline" },
        });
      return {
        status: exchange?.status ?? 0,
        clientMs: call.clientMs,
        serverMs: exchange?.serverMs,
        traceId: exchange?.traceId,
        ok: Option.isSome(parked),
        metrics: {
          approvalRequired:
            Option.isSome(parked) && parked.value.status === "approval-required" ? 1 : 0,
          timeoutExceeded: kind === "TimeoutExceeded" ? 1 : 0,
          executionFailure: kind === "ExecutionFailure" ? 1 : 0,
        },
      } satisfies Sample;
    }),
};

export const scenarios: readonly Scenario[] = [
  ...apiScenarios,
  ...slowTabScenarios,
  ...factoryScenarios,
  ...actionScenarios,
  ...sessionScenarios,
  ...executeScenarios,
  ...failureScenarios,
  approvalAfterRefresh,
  ...toolcallScenarios,
  ...lifecycleScenarios,
  ...browserScenarios,
];
