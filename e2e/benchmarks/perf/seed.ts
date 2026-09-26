/**
 * Production-shaped synthetic organizations on a perf stage, through public product APIs only.
 *
 * A seed fixes every generated choice (app kinds, tool counts, upstream latencies, accounts), so two
 * stages seeded with the same seed and emulator origin hold equivalent data. Organization identities
 * are derived from the seed as fixture scenario ids; re-running resumes from the private receipt.
 */
import { Clock, Console, Effect, FileSystem, Schema } from "effect";
import { createHash } from "node:crypto";
import { cookieHeader, productClient, PerfRequestFailed, type ProductClient } from "./client.ts";
import { formatSpec, type EmulatorSpec } from "./emulator.ts";
import { fixtureActors, stableUuid } from "./sessions.ts";
import { productionShape, random, toolsPerApp, type Random } from "./shape.ts";
import type { StageControl } from "./stage.ts";

export const AppReceipt = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["mcp", "openapi", "authored", "refresh"]),
  spec: Schema.String,
  tools: Schema.Number,
  auth: Schema.Boolean,
  url: Schema.String,
  profile: Schema.String,
  accounts: Schema.Array(Schema.String),
});
export type AppReceipt = typeof AppReceipt.Type;
export const OrgReceipt = Schema.Struct({
  key: Schema.String,
  fixtureId: Schema.String,
  label: Schema.String,
  purpose: Schema.String,
  organization: Schema.Struct({ id: Schema.String, slug: Schema.String }),
  pat: Schema.String,
  apps: Schema.Array(AppReceipt),
});
export type OrgReceipt = typeof OrgReceipt.Type;
export const Receipt = Schema.Struct({
  origin: Schema.String,
  seed: Schema.Number,
  emulator: Schema.String,
  shape: Schema.String,
  createdAt: Schema.String,
  orgs: Schema.Record(Schema.String, OrgReceipt),
});
export type Receipt = typeof Receipt.Type;

interface AppPlan {
  readonly name: string;
  /**
   * `authored` deploys an app whose factory lists an MCP server that answers 404. `refresh`
   * deploys an app whose cached read starts a background refresh that outlasts the call.
   */
  readonly kind: "mcp" | "openapi" | "authored" | "refresh";
  readonly spec: EmulatorSpec;
  readonly accounts: number;
}
interface OrgPlan {
  readonly key: string;
  readonly purpose: string;
  readonly apps: readonly AppPlan[];
}

const fast = { latencyMs: 20, jitterMs: 5, listMs: 30, coldMs: 0 };
const slow = (rng: Random) => {
  const latencyMs = Math.round(rng.quantile(productionShape.upstreamCallMs));
  return {
    latencyMs,
    jitterMs: Math.round(latencyMs * 0.3),
    listMs: Math.round(rng.quantile(productionShape.upstreamListMs)),
    coldMs: rng.int(1000, 3000),
  };
};

/** Deterministic plan: catalog-size organizations with fast and production-latency upstreams. */
export const plan = (seed: number): readonly OrgPlan[] => {
  const rng = random(seed);
  const tag = seed.toString(36);
  const org = (key: string, count: number, speed: "fast" | "slow", purpose: string): OrgPlan => ({
    key,
    purpose,
    apps: Array.from({ length: count }, (_, index) => {
      const kind = rng.next() < 0.6 ? ("mcp" as const) : ("openapi" as const);
      const auth = kind === "mcp" && rng.next() < 0.4;
      const tools = toolsPerApp(rng);
      const timing = speed === "fast" ? fast : slow(rng);
      return {
        name: `Perf ${kind === "mcp" ? "MCP" : "API"} ${String(index + 1).padStart(2, "0")}`,
        kind,
        spec: {
          tools,
          ...timing,
          errorPerMille: 0,
          auth,
          key: `s${tag}${key}${index}`,
        },
        accounts: auth ? (rng.next() < 0.3 ? 2 : 1) : 0,
      };
    }),
  });
  const call = (name: string, kind: "mcp" | "openapi", auth: boolean, index: number): AppPlan => ({
    name,
    kind,
    spec: {
      tools: 20,
      latencyMs: 0,
      jitterMs: 0,
      listMs: 0,
      coldMs: 0,
      errorPerMille: 0,
      auth,
      key: `s${tag}call${index}`,
    },
    accounts: auth ? 1 : 0,
  });
  const failing = (
    name: string,
    kind: AppPlan["kind"],
    index: number,
    spec: Partial<EmulatorSpec>,
  ): AppPlan => ({
    name,
    kind,
    spec: {
      tools: 5,
      latencyMs: 0,
      jitterMs: 0,
      listMs: 0,
      coldMs: 0,
      errorPerMille: 0,
      auth: false,
      key: `s${tag}err${index}`,
      ...spec,
    },
    accounts: 0,
  });
  return [
    {
      key: "err",
      purpose: "Execute failure classes: timeouts, apps without accounts, refused MCP servers",
      apps: [
        failing("Perf err fast", "mcp", 0, {}),
        // Every call outlasts the 30 s execution budget.
        failing("Perf err slow", "mcp", 1, { latencyMs: 45_000 }),
        // Requires an API key that no profile selects.
        failing("Perf err keyed", "mcp", 2, { auth: true }),
        failing("Perf err moved", "authored", 3, {}),
        failing("Perf err refresh", "refresh", 4, {}),
        failing("Perf err cleanup", "refresh", 5, {}),
        failing("Perf err approval", "refresh", 6, {}),
      ],
    },
    org("a1f", 1, "fast", "MCP execute, 1 app, fast upstream"),
    org("a8f", 8, "fast", "MCP execute, 8 apps, fast upstream; dashboard reads and browser"),
    org("a24f", 24, "fast", "MCP execute, 24 apps, fast upstream"),
    org("a1s", 1, "slow", "MCP execute, 1 app, production-latency upstream"),
    org("a8s", 8, "slow", "MCP execute, 8 apps, production-latency upstream"),
    org("a24s", 24, "slow", "MCP execute, 24 apps, production-latency upstream"),
    {
      key: "call",
      purpose: "Tool-call overhead with zero-latency upstreams",
      apps: [
        call("Perf call MCP", "mcp", false, 0),
        call("Perf call MCP key", "mcp", true, 1),
        call("Perf call API", "openapi", false, 2),
      ],
    },
  ];
};

/** Fixture scenario ids are 32 hex characters derived from the seed and organization key. */
export const fixtureId = (seed: number, key: string) =>
  createHash("sha256").update(`perf-0925:${seed}:${key}`).digest("hex").slice(0, 32);

const Created = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String });
const Id = Schema.Struct({ id: Schema.String });
const Inventory = Schema.Struct({
  apps: Schema.Array(Created),
  profiles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      app: Schema.String,
      accounts: Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      ),
    }),
  ),
});

const appUrl = (app: AppPlan, emulator: string) => {
  const segment = formatSpec(app.spec);
  return app.kind === "authored"
    ? `${emulator}/mcp/moved/mcp`
    : app.kind === "mcp"
      ? `${emulator}/mcp/${segment}/mcp`
      : `${emulator}/openapi/${segment}/openapi.json`;
};
const receiptFor = (
  app: AppPlan,
  emulator: string,
  created: typeof Created.Type,
  profile: string,
  accounts: readonly string[],
): AppReceipt => ({
  id: created.id,
  slug: created.slug,
  name: app.name,
  kind: app.kind,
  spec: formatSpec(app.spec),
  tools: app.spec.tools,
  auth: app.spec.auth,
  url: appUrl(app, emulator),
  profile,
  accounts,
});
const Key = Schema.Struct({ key: Schema.String });

const expectOk = (operation: string, response: { status: number; body: unknown }) =>
  response.status === 200
    ? Effect.succeed(response.body)
    : Effect.fail(
        new PerfRequestFailed({
          operation,
          status: response.status,
          detail: JSON.stringify(response.body).slice(0, 300),
        }),
      );

// `seed` caches a value that is stale at once; `stale` serves it and refreshes it for up to 30 s.
const refreshSource = `import { defineApp, query, mutation, object, string } from "apps";
import { always } from "apps/operations/approval";
const slowRefresh = (signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, 60_000);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
});
const options = (key) => ({ key, schema: string(), freshFor: 0, staleFor: "10 minutes" });
export default defineApp({ accounts: {} }, async (ctx) => ({ queries: {
  pause: query({ input: object({}) }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return true;
  }),
  seed: query({ input: object({ key: string() }) }, async (_, { key }) => ctx.cache.get({ ...options(key), load: async () => "seed" })),
  stale: query({ input: object({ key: string() }) }, async (_, { key }) => ctx.cache.get({ ...options(key), load: async ({ signal }) => {
    await slowRefresh(signal);
    return "refreshed";
  } })),
}, mutations: {
  approved: mutation({ input: object({}), approval: always() }, async () => ({ ran: true })),
} }));`;

const seedApp = (client: ProductClient, root: string, app: AppPlan, emulator: string) =>
  Effect.gen(function* () {
    const url = appUrl(app, emulator);
    if (app.kind === "refresh") {
      const deployed = yield* client
        .request("POST", `${root}/apps/deploy`, {
          name: app.name,
          files: [{ path: "index.ts", content: refreshSource }],
        })
        .pipe(
          Effect.flatMap((response) => expectOk(`deploy ${app.name}`, response)),
          Effect.flatMap(Schema.decodeUnknownEffect(Created)),
        );
      return receiptFor(app, emulator, deployed, "", []);
    }
    if (app.kind === "authored") {
      const deployed = yield* client
        .request("POST", `${root}/apps/deploy`, {
          name: app.name,
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } }),
            },
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";
import { mcpOperations } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => mcpOperations({ url: ${JSON.stringify(url)} }));`,
            },
          ],
        })
        .pipe(
          Effect.flatMap((response) => expectOk(`deploy ${app.name}`, response)),
          Effect.flatMap(Schema.decodeUnknownEffect(Created)),
        );
      return receiptFor(app, emulator, deployed, "", []);
    }
    const source =
      app.kind === "mcp"
        ? {
            kind: "mcp",
            name: app.name,
            url,
            auth: app.spec.auth
              ? { type: "apiKey", header: "x-api-key", prefix: "" }
              : { type: "none" },
          }
        : { kind: "openapi", name: app.name, url };
    const imported = yield* client.request("POST", `${root}/apps/import`, { source }).pipe(
      Effect.flatMap((response) => expectOk(`import ${app.name}`, response)),
      Effect.flatMap(Schema.decodeUnknownEffect(Created)),
    );
    const appPath = `${root}/apps/${imported.id}`;
    const profile = yield* client
      .request("POST", `${appPath}/profiles`, {
        accounts: {},
        idempotencyKey: stableUuid(`${imported.id}:profile`),
      })
      .pipe(
        Effect.flatMap((response) => expectOk(`profile ${app.name}`, response)),
        Effect.flatMap(Schema.decodeUnknownEffect(Id)),
      );
    const accounts: string[] = [];
    for (let account = 0; account < app.accounts; account++) {
      const connection = yield* client
        .request("POST", `${appPath}/connections`, {
          profile: profile.id,
          requirement: "service",
          destination: { kind: "shared", audience: { kind: "everyone" } },
        })
        .pipe(
          Effect.flatMap((response) => expectOk(`connection ${app.name}`, response)),
          Effect.flatMap(Schema.decodeUnknownEffect(Id)),
        );
      const saved = yield* client
        .request("POST", `${root}/connections/${connection.id}/submit`, {
          method: "apiKey",
          label: `Synthetic ${app.name} ${account + 1}`,
          fields: { token: `synthetic-perf-${app.spec.key}-${account}` },
        })
        .pipe(
          Effect.flatMap((response) => expectOk(`account ${app.name}`, response)),
          Effect.flatMap(Schema.decodeUnknownEffect(Id)),
        );
      accounts.push(saved.id);
    }
    if (accounts.length > 0) {
      const current = yield* client.request("GET", `${appPath}/profiles/${profile.id}`).pipe(
        Effect.flatMap((response) => expectOk(`read profile ${app.name}`, response)),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Number }))),
      );
      yield* client
        .request("PATCH", `${appPath}/profiles/${profile.id}`, {
          expectedRevision: current.revision,
          accounts: { service: accounts },
        })
        .pipe(Effect.flatMap((response) => expectOk(`select accounts ${app.name}`, response)));
    }
    return receiptFor(app, emulator, imported, profile.id, accounts);
  });

/** Seed (or resume seeding) every planned organization; writes the receipt after each app. */
export const seedStage = (input: {
  readonly control: StageControl;
  readonly receipt: string;
  readonly seed: number;
  readonly emulator: string;
  readonly only?: readonly string[];
  readonly concurrency: number;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = (yield* fs.exists(input.receipt))
      ? yield* fs
          .readFileString(input.receipt)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt))))
      : undefined;
    if (
      existing !== undefined &&
      (existing.origin !== input.control.origin ||
        existing.seed !== input.seed ||
        existing.emulator !== input.emulator)
    )
      return yield* new PerfRequestFailed({
        operation: "seed",
        detail: "Existing receipt was made for another stage, seed or emulator",
      });
    const receipt: { -readonly [K in keyof Receipt]: Receipt[K] } & {
      orgs: Record<string, OrgReceipt>;
    } = {
      origin: input.control.origin,
      seed: input.seed,
      emulator: input.emulator,
      shape: productionShape.source,
      createdAt: existing?.createdAt ?? new Date(yield* Clock.currentTimeMillis).toISOString(),
      orgs: { ...existing?.orgs },
    };
    const save = Effect.suspend(() =>
      fs.writeFileString(input.receipt, JSON.stringify(receipt, null, 2), { mode: 0o600 }),
    );
    for (const org of plan(input.seed)) {
      if (input.only !== undefined && input.only.length > 0 && !input.only.includes(org.key))
        continue;
      const id = fixtureId(input.seed, org.key);
      const label = `perf ${org.key}`;
      const actors = yield* fixtureActors(input.control, id, label);
      const client = yield* productClient(
        input.control.origin,
        cookieHeader(actors.actors.owner.cookies),
      );
      const root = `/api/organizations/${actors.organization.id}`;
      const previous = receipt.orgs[org.key];
      let pat = previous?.pat;
      if (pat === undefined) {
        pat = (yield* client
          .request("POST", "/api/auth/api-key/create", { name: `Perf ${org.key}` })
          .pipe(
            Effect.flatMap((response) => expectOk("api key", response)),
            Effect.flatMap(Schema.decodeUnknownEffect(Key)),
          )).key;
      }
      const apps: AppReceipt[] = [...(previous?.apps ?? [])];
      const entry = () =>
        ({
          key: org.key,
          fixtureId: id,
          label,
          purpose: org.purpose,
          organization: actors.organization,
          pat: pat!,
          apps: [...apps].sort((a, b) => a.name.localeCompare(b.name)),
        }) satisfies OrgReceipt;
      receipt.orgs[org.key] = entry();
      yield* save;
      // Recover apps an interrupted run created before its receipt was written.
      const inventory = yield* client.request("GET", `${root}/inventory`).pipe(
        Effect.flatMap((response) => expectOk("inventory", response)),
        Effect.flatMap(Schema.decodeUnknownEffect(Inventory)),
      );
      for (const app of org.apps) {
        if (apps.some((entry) => entry.name === app.name)) continue;
        const found = inventory.apps.find((entry) => entry.name === app.name);
        const profile = inventory.profiles.find((entry) => entry.app === found?.id);
        if (found === undefined || profile === undefined) continue;
        const selected = profile.accounts.service;
        const accounts =
          selected === undefined ? [] : typeof selected === "string" ? [selected] : selected;
        if (accounts.length !== app.accounts) continue;
        apps.push(receiptFor(app, input.emulator, found, profile.id, accounts));
      }
      const done = new Set(apps.map((app) => app.name));
      const pending = org.apps.filter((app) => !done.has(app.name));
      const started = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        pending,
        (app) =>
          seedApp(client, root, app, input.emulator).pipe(
            Effect.tap((created) =>
              Effect.gen(function* () {
                apps.push(created);
                receipt.orgs[org.key] = entry();
                yield* save;
              }),
            ),
          ),
        { concurrency: input.concurrency, discard: true },
      );
      receipt.orgs[org.key] = entry();
      yield* save;
      yield* Console.log(
        `${org.key}: ${apps.length} apps, ${apps.reduce((n, a) => n + a.accounts.length, 0)} accounts, ` +
          `${apps.reduce((n, a) => n + a.tools, 0)} tools (${Math.round(((yield* Clock.currentTimeMillis) - started) / 1000)} s)`,
      );
    }
    return receipt;
  });

export const readReceipt = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt))));
  });
