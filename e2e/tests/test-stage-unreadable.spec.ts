/**
 * A test stage whose Alchemy records the state store cannot read is removed only by an explicit
 * `test-stage destroy --by-name`, by the names and tags the stage implies. These cases run the
 * `test-stage` CLI as a process against a recorded copy of the state store and the Cloudflare,
 * Neon and Axiom APIs, which also holds production's resources and neighbouring stages' shaped as
 * the real ones are, and a disposable Postgres for the stage registry.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const account = "0123456789abcdef0123456789abcdef";
const testZone = { id: "zone-test", name: "executor.engineering" };
const appZone = { id: "zone-app", name: "executor.website" };
const otherZone = { id: "zone-other", name: "executor.sh" };
const stackTag = "alchemy:stack:executor-next-hosted";
const tags = (stage: string, id: string, stack = stackTag) => [
  stack,
  `alchemy:stage:${stage}`,
  `alchemy:id:${id}`,
];
/** Physical names as Alchemy gave them to real stages: untruncated for pr-2994, hashed for search-loop. */
const pr2994 = {
  api: "executor-next-hosted-api-test-pr-2994-s6qio74pydelrhgd",
  pages: "executor-next-hosted-apppages-2hh3rqvfveyv4kykb7awstll",
  appBuilds: "executor-next-hosted-appbuilds-test-pr-2994-blh4acnhiamks2cf",
  siteAssets: "executor-next-hosted-siteassets-test-pr-2994-o6dtg2eht7y7rlwd",
};
const searchLoop = {
  api: "executor-next-hosted-api-test-tihjxw6bd7v6f6zucbp7r7zg",
  appBuilds: "executor-next-hosted-appbuilds-test-sea77k6gpytetonhh4hwltku7qi",
  siteAssets: "executor-next-hosted-siteassets-test-seizk3kua2qgdlz52qqnbuxner",
};

interface Fault {
  readonly method: string;
  /** Matches the request path, query included. */
  readonly path: RegExp;
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** How many requests it answers; omitted, every one. */
  times?: number;
  /** It answers only after this many DELETE requests, as a check after removal would see. */
  readonly afterDeletes?: number;
}

/** The services' contents, which the recorded APIs list and delete from. */
interface World {
  workers: Array<{ id: string; tags: string[] | null }>;
  zones: Array<{ id: string; name: string }>;
  routes: Record<string, Array<{ id: string; pattern: string; script?: string }>>;
  domains: Array<{ id: string; hostname: string; service: string }>;
  workflows: Array<{ name: string; script_name: string }>;
  buckets: Record<string, string[]>;
  dns: Record<string, Array<{ id: string; name: string; type: string }>>;
  destinations: Array<{ slug: string; name: string }>;
  hyperdrive: Array<{ id: string; name: string }>;
  certificates: Array<{ id: string; name: string | null }>;
  /** The Artifacts namespaces and how many repositories each holds. */
  artifacts: Record<string, number>;
  /** Whether a namespace's repository list leaves out its total, as no real answer does. */
  repositoriesWithoutTotal?: boolean;
  /** Whether the namespace list hands back the second page's cursor again and again. */
  repeatNamespaceCursor?: boolean;
  branches: Array<{ id: string; name: string; default: boolean }>;
  monitors: Array<{ id: string; name: string }>;
  tokens: Array<{ id: string; name: string }>;
  /** Alchemy records by stage and logical ID: readable, undecryptable, or failing that many reads. */
  state: Record<string, Record<string, "readable" | "undecryptable" | number>>;
  faults: Fault[];
  /** The PlanetScale test database's branches: whether production, and what a delete answers. */
  planetscale?: Record<string, { production: boolean; deleteStatus: number }>;
  /** The account's Durable Object namespaces, by the Worker that exports each class. */
  namespaces?: Array<{ script: string }>;
  /** How many more namespaces the listing's `total_count` claims than it returns. */
  namespacesUnlisted?: number;
  /** Pages of the bucket listing, by name, when the listing is paginated. */
  bucketPages?: ReadonlyArray<ReadonlyArray<string>>;
  /** Listing results that report more pages than they return. */
  partial?: ReadonlyArray<string>;
  requests: string[];
}

const pr2994World = (): World => ({
  workers: [
    { id: pr2994.api, tags: tags("test-pr-2994", "Api") },
    { id: pr2994.pages, tags: tags("test-pr-2994", "AppPages") },
    // Another stack's Worker in the same stage is not this stack's.
    {
      id: "executor-pr-preview-comments-x-test-pr-2994-aaaaaaaaaaaaaaaa",
      tags: tags("test-pr-2994", "Comment", "alchemy:stack:executor-pr-preview-comments"),
    },
    // A neighbour whose slug is a prefix of this one, and one this one is a prefix of.
    {
      id: "executor-next-hosted-api-test-pr-299-bbbbbbbbbbbbbbbb",
      tags: tags("test-pr-299", "Api"),
    },
    {
      id: "executor-next-hosted-api-test-pr-29940-cccccccccccccccc",
      tags: tags("test-pr-29940", "Api"),
    },
    { id: "executor-next-hosted-api-v2-dddddddddddddddd", tags: tags("v2", "Api") },
    // Named like this stage's but untagged.
    { id: "executor-next-hosted-api-test-pr-2994-eeeeeeeeeeeeeeee", tags: null },
  ],
  zones: [testZone, appZone, otherZone],
  routes: {
    [testZone.id]: [
      { id: "route-api", pattern: "api.pr-2994.executor.engineering/*", script: pr2994.api },
      {
        id: "route-neighbour",
        pattern: "api.pr-299.executor.engineering/*",
        script: "executor-next-hosted-api-test-pr-299-bbbbbbbbbbbbbbbb",
      },
    ],
    [appZone.id]: [
      { id: "route-pages", pattern: "*.pr-2994.executor.website/*", script: pr2994.pages },
      {
        id: "route-production",
        pattern: "*.executor.website/*",
        script: "executor-next-hosted-api-v2-dddddddddddddddd",
      },
    ],
    [otherZone.id]: [
      { id: "route-other-zone", pattern: "pr-2994.executor.sh/*", script: pr2994.api },
    ],
  },
  domains: [
    { id: "domain-own", hostname: "pr-2994.executor.engineering", service: pr2994.api },
    {
      id: "domain-neighbour",
      hostname: "pr-299.executor.engineering",
      service: "executor-next-hosted-api-test-pr-299-bbbbbbbbbbbbbbbb",
    },
  ],
  workflows: [
    { name: `${pr2994.api}-eae6c5ea`, script_name: pr2994.api },
    {
      name: "executor-next-hosted-api-test-pr-299-bbbbbbbbbbbbbbbb-eae6c5ea",
      script_name: "executor-next-hosted-api-test-pr-299-bbbbbbbbbbbbbbbb",
    },
  ],
  buckets: {
    [pr2994.appBuilds]: [],
    [pr2994.siteAssets]: ["_astro/a.js", "_astro/b.css"],
    "executor-next-hosted-siteassets-test-pr-299-o6dtg2eht7y7rlwd": [],
    "executor-next-hosted-siteassets-test-pr-29940-o6dtg2eht7y7rlwd": [],
    "executor-next-hosted-siteassets-v2-o6dtg2eht7y7rlwd": [],
  },
  dns: {
    [testZone.id]: [
      { id: "dns-bare", name: "pr-2994.executor.engineering", type: "AAAA" },
      { id: "dns-api", name: "api.pr-2994.executor.engineering", type: "AAAA" },
      { id: "dns-neighbour", name: "api.pr-299.executor.engineering", type: "AAAA" },
      { id: "dns-longer", name: "api.pr-29940.executor.engineering", type: "AAAA" },
      { id: "dns-deeper", name: "a.b.pr-2994.executor.engineering", type: "AAAA" },
    ],
    [appZone.id]: [
      { id: "dns-team", name: "*.team.pr-2994.executor.website", type: "AAAA" },
      { id: "dns-team-host", name: "team.pr-2994.executor.website", type: "AAAA" },
      // Production writes one label per team, and a team may be named like the base.
      { id: "dns-production-team", name: "*.pr-2994.executor.website", type: "AAAA" },
      { id: "dns-neighbour-team", name: "*.team.pr-299.executor.website", type: "AAAA" },
    ],
  },
  destinations: [
    { slug: "dest-own", name: "executor-next-test-pr-2994-platform-traces" },
    { slug: "dest-neighbour", name: "executor-next-test-pr-299-platform-traces" },
  ],
  hyperdrive: [],
  certificates: [],
  artifacts: {
    // More than one page of namespaces, as the account has, with this stage's on the second.
    ...Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`executor-test-e2e-${index}-apps`, 0]),
    ),
    "executor-test-pr-2994-apps": 0,
    "executor-test-pr-299-apps": 2,
    "executor-v2-apps": 5,
  },
  branches: [
    { id: "br-own", name: "test-pr-2994", default: false },
    { id: "br-neighbour", name: "test-pr-29940", default: false },
    { id: "br-parent", name: "main", default: true },
  ],
  monitors: [
    { id: "mon-own", name: "Executor test-pr-2994: app browser failures" },
    { id: "mon-neighbour", name: "Executor test-pr-299: app browser failures" },
    { id: "mon-production", name: "Executor v2: app browser failures" },
  ],
  tokens: [
    { id: "tok-own", name: "executor-next-test-pr-2994-ingest" },
    { id: "tok-production", name: "executor-next-v2-ingest" },
  ],
  state: {
    "test-pr-2994": {
      Api: "undecryptable",
      AppPages: "undecryptable",
      AuthSecret: "undecryptable",
    },
  },
  faults: [],
  requests: [],
});

const envelope = (result: unknown, result_info?: unknown) => ({
  success: true,
  errors: [],
  messages: [],
  result,
  ...(result_info === undefined ? {} : { result_info }),
});

/** Answer one request from the world, or a fault queued for it. */
const answer = (world: World, method: string, url: URL, body: string, authorization = "") => {
  const path = url.pathname;
  const query = url.search;
  const deletes = world.requests.filter((request) => request.startsWith("DELETE ")).length;
  const fault = world.faults.find(
    (candidate) =>
      candidate.method === method &&
      candidate.path.test(`${path}${query}`) &&
      (candidate.times === undefined || candidate.times > 0) &&
      deletes >= (candidate.afterDeletes ?? 0),
  );
  world.requests.push(`${method} ${path}${query}`);
  if (fault !== undefined) {
    if (fault.times !== undefined) fault.times -= 1;
    return { status: fault.status, headers: fault.headers ?? {}, body: "" };
  }
  const ok = (result: unknown, info?: unknown) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(envelope(result, info)),
  });
  const json = (value: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(value) });
  const gone = { status: 200, headers: {}, body: JSON.stringify(envelope(null)) };
  const missing = { status: 404, headers: {}, body: JSON.stringify({ success: false }) };
  const partial = (kind: string) => world.partial?.includes(kind) === true;
  const cf = `/client/v4/accounts/${account}`;
  let match: RegExpExecArray | null;

  // The state store.
  if (path === "/version") return json({ version: 7 });
  if ((match = /^\/state\/stacks\/([^/]+)\/stages\/([^/]+)\/resources$/u.exec(path)))
    return json(Object.keys(world.state[decodeURIComponent(match[2]!)] ?? {}));
  if ((match = /^\/state\/stacks\/([^/]+)\/stages\/([^/]+)\/resources\/([^/]+)$/u.exec(path))) {
    const records = world.state[decodeURIComponent(match[2]!)] ?? {};
    const fqn = decodeURIComponent(match[3]!);
    const record = records[fqn];
    if (record === undefined) return { status: 204, headers: {}, body: "" };
    if (record === "undecryptable") return { status: 500, headers: {}, body: "" };
    if (typeof record === "number") {
      records[fqn] = record > 1 ? record - 1 : "readable";
      return { status: 500, headers: {}, body: "" };
    }
    return json({
      fqn,
      logicalId: fqn,
      resourceType: "Alchemy.Random",
      status: "created",
      attr: {},
    });
  }
  if ((match = /^\/state\/stacks\/([^/]+)$/u.exec(path)) && method === "DELETE") {
    const stage = url.searchParams.get("stage");
    if (stage !== null) world.state[stage] = {};
    return { status: 204, headers: {}, body: "" };
  }

  // PlanetScale: the test database's branches.
  if (
    (match =
      /^\/v1\/organizations\/synthetic-org\/databases\/executor-test\/branches(?:\/([^/]+))?$/u.exec(
        path,
      ))
  ) {
    const branches = world.planetscale ?? {};
    const name = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
    if (name === undefined && method === "GET")
      return json({
        type: "list",
        current_page: 1,
        next_page: null,
        data: Object.keys(branches).map((branch) => ({
          name: branch,
          created_at: "2026-11-16T00:00:00Z",
        })),
      });
    const branch = name === undefined ? undefined : branches[name];
    if (branch === undefined) return missing;
    if (method === "GET") return json({ name, production: branch.production, ready: false });
    if (method === "DELETE") {
      if (branch.deleteStatus !== 204)
        return {
          status: branch.deleteStatus,
          headers: {},
          body: JSON.stringify({ code: "forbidden" }),
        };
      delete branches[name!];
      return { status: 204, headers: {}, body: "" };
    }
  }

  // Cloudflare.
  if (path === `${cf}/workers/scripts`) {
    if (method === "GET")
      return ok(
        world.workers.map((worker) => ({ ...worker, created_on: "2026-10-01T00:00:00Z" })),
        partial("workers") ? { page: 1, total_pages: 2 } : undefined,
      );
  }
  if (
    (match = new RegExp(`^${cf}/workers/scripts/([^/]+)$`, "u").exec(path)) &&
    method === "DELETE"
  ) {
    const name = decodeURIComponent(match[1]!);
    world.workers = world.workers.filter((worker) => worker.id !== name);
    return gone;
  }
  if (path === `${cf}/workers/durable_objects/namespaces` && method === "GET") {
    // As Cloudflare answers: `total_count` and no page count. It gives at most 300 a page here,
    // fewer than the CLI asks for, so the account's namespaces take two pages.
    const all = world.namespaces ?? [];
    const page = Number(url.searchParams.get("page") ?? "1");
    const per = Math.min(Number(url.searchParams.get("per_page") ?? "20"), 300);
    const results = all.slice((page - 1) * per, page * per);
    return ok(results, {
      page,
      per_page: per,
      count: results.length,
      total_count: all.length + (world.namespacesUnlisted ?? 0),
    });
  }
  if (path === "/client/v4/zones") return ok(world.zones, { page: 1, total_pages: 1 });
  if ((match = /^\/client\/v4\/zones\/([^/]+)\/workers\/routes(?:\/([^/]+))?$/u.exec(path))) {
    const zone = match[1]!;
    if (method === "GET") return ok(world.routes[zone] ?? []);
    world.routes[zone] = (world.routes[zone] ?? []).filter((route) => route.id !== match![2]);
    return gone;
  }
  if ((match = new RegExp(`^${cf}/workers/domains(?:/([^/]+))?$`, "u").exec(path))) {
    if (method === "GET") return ok(world.domains);
    world.domains = world.domains.filter((domain) => domain.id !== match![1]);
    return gone;
  }
  if (path === `${cf}/workflows` && method === "GET") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const per = Number(url.searchParams.get("per_page") ?? "100");
    const total = Math.max(1, Math.ceil(world.workflows.length / per));
    return ok(world.workflows.slice((page - 1) * per, page * per), { page, total_pages: total });
  }
  if ((match = new RegExp(`^${cf}/workflows/([^/]+)$`, "u").exec(path)) && method === "DELETE") {
    const name = decodeURIComponent(match[1]!);
    world.workflows = world.workflows.filter((flow) => flow.name !== name);
    return gone;
  }
  if (path === `${cf}/r2/buckets` && method === "GET") {
    const contains = url.searchParams.get("name_contains") ?? "";
    if (world.bucketPages !== undefined) {
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const names = world.bucketPages[cursor]!.filter((name) => name in world.buckets);
      return ok(
        { buckets: names.map((name) => ({ name })) },
        { cursor: cursor + 1 < world.bucketPages.length ? String(cursor + 1) : "" },
      );
    }
    return ok({
      buckets: Object.keys(world.buckets)
        .filter((name) => name.includes(contains))
        .map((name) => ({ name })),
    });
  }
  if ((match = new RegExp(`^${cf}/r2/buckets/([^/]+)/objects$`, "u").exec(path))) {
    const bucket = decodeURIComponent(match[1]!);
    if (method === "GET") return ok((world.buckets[bucket] ?? []).map((key) => ({ key })));
    const keys = JSON.parse(body) as string[];
    world.buckets[bucket] = (world.buckets[bucket] ?? []).filter((key) => !keys.includes(key));
    return gone;
  }
  if ((match = new RegExp(`^${cf}/r2/buckets/([^/]+)$`, "u").exec(path)) && method === "DELETE") {
    const bucket = decodeURIComponent(match[1]!);
    if (!(bucket in world.buckets)) return missing;
    if (world.buckets[bucket]!.length > 0) return { status: 409, headers: {}, body: "" };
    delete world.buckets[bucket];
    return gone;
  }
  if ((match = /^\/client\/v4\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/u.exec(path))) {
    const zone = match[1]!;
    if (method === "GET") {
      const contains = url.searchParams.get("name.contains") ?? "";
      return ok(
        (world.dns[zone] ?? []).filter((record) => record.name.includes(contains)),
        partial("dns") ? { page: 1, total_pages: 2 } : undefined,
      );
    }
    world.dns[zone] = (world.dns[zone] ?? []).filter((record) => record.id !== match![2]);
    return gone;
  }
  if (
    (match = new RegExp(`^${cf}/workers/observability/destinations(?:/([^/]+))?$`, "u").exec(path))
  ) {
    if (method === "GET") return ok(world.destinations);
    world.destinations = world.destinations.filter((destination) => destination.slug !== match![1]);
    return gone;
  }
  if (path === `${cf}/hyperdrive/configs`) return ok(world.hyperdrive);
  if (path === `${cf}/mtls_certificates`) return ok(world.certificates);
  // Artifacts answer only the token minted for them, never the test-stage token.
  if (path.startsWith(`${cf}/artifacts/`) && authorization !== "Bearer artifacts-token")
    return { status: 401, headers: {}, body: "" };
  if (path === `${cf}/artifacts/namespaces` && method === "GET") {
    const all = Object.entries(world.artifacts);
    const from = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const next =
      world.repeatNamespaceCursor === true
        ? String(limit)
        : from + limit < all.length
          ? String(from + limit)
          : "";
    return ok(
      all.slice(from, from + limit).map(([namespace, repo_count]) => ({
        namespace,
        repo_count,
        jurisdiction: "default",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      })),
      { cursor: next, per_page: limit, count: Math.min(limit, all.length - from) },
    );
  }
  if ((match = new RegExp(`^${cf}/artifacts/namespaces/([^/]+)/repos$`, "u").exec(path))) {
    // A namespace that does not exist lists as empty, as Cloudflare's does.
    const total = world.artifacts[decodeURIComponent(match[1]!)] ?? 0;
    const shown = Math.min(total, 50);
    return ok(
      Array.from({ length: shown }, (_, index) => ({ id: `repo-${index}`, name: `repo-${index}` })),
      world.repositoriesWithoutTotal === true
        ? { page: 1, per_page: 50, total_pages: Math.ceil(total / 50), count: shown }
        : {
            page: 1,
            per_page: 50,
            total_pages: Math.ceil(total / 50),
            count: shown,
            total_count: total,
          },
    );
  }

  // Neon.
  if ((match = /^\/api\/v2\/projects\/test-project\/branches(?:\/([^/]+))?$/u.exec(path))) {
    if (method === "GET") return json({ branches: world.branches });
    world.branches = world.branches.filter((branch) => branch.id !== match![1]);
    return json({});
  }

  // Axiom.
  if ((match = /^\/v2\/(monitors|tokens)(?:\/([^/]+))?$/u.exec(path))) {
    const kind = match[1] as "monitors" | "tokens";
    if (method === "GET") return json(world[kind]);
    world[kind] = world[kind].filter((item) => item.id !== match![2]);
    return { status: 204, headers: {}, body: "" };
  }
  return missing;
};

/** The recorded APIs on a local port, for the life of the scope. */
const recordedApis = (world: World) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly origin: string; readonly close: () => void }>((resume) => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const url = new URL(request.url ?? "/", "http://recorded");
          const reply = answer(
            world,
            request.method ?? "GET",
            url,
            body,
            request.headers.authorization ?? "",
          );
          response.writeHead(reply.status, {
            "content-type": "application/json",
            ...reply.headers,
          });
          response.end(reply.body);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, close: () => server.close() }));
      });
    }),
    (apis) => Effect.sync(apis.close),
  );

/** A disposable Postgres with the registry's admin role, removed when the scope closes. */
const registry = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const container = `executor-stage-registry-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  const docker = (args: ReadonlyArray<string>) =>
    processes.exitCode(
      ChildProcess.make("docker", args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    );
  const started = yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=executor",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17",
    ]),
    () => docker(["rm", "--force", container]).pipe(Effect.ignore),
  );
  if (Number(started) !== 0) return yield* Effect.die(new Error("Could not start Postgres."));
  const port = (yield* processes.string(
    ChildProcess.make("docker", ["port", container, "5432/tcp"]),
  ))
    .trim()
    .split(":")
    .at(-1);
  // The image's first server is Unix-only while it initialises; wait for the TCP listener.
  yield* processes
    .string(
      ChildProcess.make("sh", [
        "-c",
        `docker exec ${container} pg_isready -h 127.0.0.1 -U executor >/dev/null 2>&1 && echo ready || echo waiting`,
      ]),
    )
    .pipe(
      Effect.flatMap((state) =>
        state.trim() === "ready" ? Effect.void : Effect.fail(new Error("Postgres is not ready.")),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
      Effect.orDie,
    );
  const psql = (sql: string) =>
    processes.string(
      ChildProcess.make("docker", [
        "exec",
        container,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-U",
        "executor",
        "-d",
        "postgres",
        "-c",
        sql,
      ]),
    );
  yield* psql(`create role "stage.admin" login superuser password '${password}'`);
  return { url: `postgresql://stage.admin:${password}@127.0.0.1:${port}/postgres`, psql };
});

/** Run the CLI once against the world. */
const cli = (
  world: World,
  args: ReadonlyArray<string>,
  options: {
    readonly registry?: string;
    readonly env?: Record<string, string>;
    /** Run as the CLI runs without `apps/hosted/cloud/scripts/with-artifacts-token.sh`. */
    readonly withoutArtifactsToken?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const apis = yield* recordedApis(world);
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/cloud/scripts/test-stage.ts", ...args], {
        env: {
          PATH: options.env?.PATH ?? process.env.PATH ?? "",
          CI: "true",
          CLOUDFLARE_ACCOUNT_ID: account,
          CLOUDFLARE_API_TOKEN: "cloudflare-token",
          ...(options.withoutArtifactsToken === true
            ? {}
            : { CLOUDFLARE_ARTIFACTS_TOKEN: "artifacts-token" }),
          NEON_API_KEY: "neon-key",
          AXIOM_TOKEN: "axiom-token",
          AXIOM_ORG_ID: "axiom-org",
          TEST_STAGE_NEON_PROJECT_ID: "test-project",
          TEST_STAGE_DOMAIN: "executor.engineering",
          EXECUTOR_APP_DOMAIN_ZONE: "executor.website",
          TEST_STAGE_CLOUDFLARE_API: apis.origin,
          TEST_STAGE_NEON_API: apis.origin,
          TEST_STAGE_AXIOM_API: apis.origin,
          TEST_STAGE_STATE_STORE_URL: apis.origin,
          TEST_STAGE_STATE_STORE_TOKEN: "state-token",
          // Only read when a case names a PlanetScale test database.
          TEST_STAGE_PLANETSCALE_API: apis.origin,
          TEST_STAGE_REMOVAL_SETTLE: "10 millis",
          TEST_STAGE_API_BACKOFF: "10 millis",
          ...(options.registry === undefined
            ? {}
            : { TEST_STAGE_DATABASE_ADMIN_URL: options.registry }),
          ...options.env,
        },
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stdout, stderr, output: `${stdout}\n${stderr}` };
  }).pipe(Effect.scoped);

const inventory = (world: World, slug: string) =>
  cli(world, ["inventory", slug]).pipe(
    Effect.map((result) => {
      expect(result.code, result.output).toBe(0);
      return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as Record<
        string,
        unknown
      > & {
        readonly blockers: ReadonlyArray<string>;
      };
    }),
  );
const deletes = (world: World) => world.requests.filter((request) => request.startsWith("DELETE "));
const lease = (slug: string, database = "neon", createdAt = "2026-10-15T00:00:00Z", owner = slug) =>
  `insert into executor_test_stage_leases (slug, owner, created_at, expires_at, database_provider, retention, background)
   values ('${slug}', '${owner.replaceAll("'", "''")}', '${createdAt}', null, '${database}', 'retained', 'active')`;
/** The registry table exists once the CLI has connected; `inventory` does not connect, `list` does. */
const prepareRegistry = (world: World, url: string) =>
  cli(world, ["list"], { registry: url }).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result.code, result.output).toBe(0))),
  );

describe("Removing a test stage by name", () => {
  it.live("selects only the stage's own resources, never production's or a neighbour's", () =>
    Effect.gen(function* () {
      const found = yield* inventory(pr2994World(), "pr-2994");
      expect(found).toMatchObject({
        stage: "test-pr-2994",
        state: { records: 3, readable: false },
        workers: [pr2994.api, pr2994.pages],
        routes: [
          { zone: "zone-test", id: "route-api", pattern: "api.pr-2994.executor.engineering/*" },
          { zone: "zone-app", id: "route-pages", pattern: "*.pr-2994.executor.website/*" },
          { zone: "zone-other", id: "route-other-zone", pattern: "pr-2994.executor.sh/*" },
        ],
        domains: [{ id: "domain-own", hostname: "pr-2994.executor.engineering" }],
        workflows: [`${pr2994.api}-eae6c5ea`],
        buckets: [pr2994.appBuilds, pr2994.siteAssets],
        records: [
          { zone: "zone-test", id: "dns-bare", name: "pr-2994.executor.engineering" },
          { zone: "zone-test", id: "dns-api", name: "api.pr-2994.executor.engineering" },
        ],
        appRecords: [
          { zone: "zone-app", id: "dns-team", name: "*.team.pr-2994.executor.website" },
          { zone: "zone-app", id: "dns-team-host", name: "team.pr-2994.executor.website" },
        ],
        appBases: ["pr-2994"],
        destinations: [{ slug: "dest-own", name: "executor-next-test-pr-2994-platform-traces" }],
        branches: [{ id: "br-own", name: "test-pr-2994" }],
        monitors: [{ id: "mon-own", name: "Executor test-pr-2994: app browser failures" }],
        tokens: [{ id: "tok-own", name: "executor-next-test-pr-2994-ingest" }],
        artifacts: { namespace: "executor-test-pr-2994-apps", exists: true, repositories: 0 },
        blockers: [],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("selects a shorter neighbour's resources for it and none of the longer slug's", () =>
    Effect.gen(function* () {
      const world = pr2994World();
      world.state["test-pr-299"] = { Api: "undecryptable" };
      const found = yield* inventory(world, "pr-299");
      expect(found).toMatchObject({
        workers: ["executor-next-hosted-api-test-pr-299-bbbbbbbbbbbbbbbb"],
        buckets: ["executor-next-hosted-siteassets-test-pr-299-o6dtg2eht7y7rlwd"],
        records: [{ id: "dns-neighbour" }],
        monitors: [{ id: "mon-neighbour" }],
        tokens: [],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("selects a long slug's truncated bucket names by their hash", () =>
    Effect.gen(function* () {
      const world = pr2994World();
      world.workers.push({ id: searchLoop.api, tags: tags("test-search-loop", "Api") });
      Object.assign(world.buckets, {
        [searchLoop.appBuilds]: [],
        [searchLoop.siteAssets]: [],
        // The same truncated start and instance characters with another stage's hash.
        "executor-next-hosted-siteassets-test-seaaaaaaaaetonhh4hwltku7qi": [],
      });
      world.state["test-search-loop"] = { Api: "undecryptable" };
      const found = yield* inventory(world, "search-loop");
      expect(found.buckets).toEqual([searchLoop.appBuilds, searchLoop.siteAssets]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("finds app-zone records under the base the stage's own route serves, not its slug", () =>
    Effect.gen(function* () {
      const world = pr2994World();
      world.routes[appZone.id] = [
        { id: "route-pages", pattern: "*.reload0922.executor.website/*", script: pr2994.pages },
      ];
      world.dns[appZone.id] = [
        { id: "dns-own-team", name: "*.team.reload0922.executor.website", type: "AAAA" },
        // Another stage whose app base is this one's slug.
        { id: "dns-other-stage", name: "*.team.pr-2994.executor.website", type: "AAAA" },
        { id: "dns-production-team", name: "*.reload0922.executor.website", type: "AAAA" },
      ];
      const found = yield* inventory(world, "pr-2994");
      expect(found).toMatchObject({
        appBases: ["reload0922"],
        appRecords: [{ id: "dns-own-team" }],
        blockers: [],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a stage that serves apps when no route names its app base", () =>
    Effect.gen(function* () {
      const world = pr2994World();
      world.routes[appZone.id] = [];
      const found = yield* inventory(world, "pr-2994");
      expect(found.blockers).toEqual([
        "test-pr-2994 serves apps but none of its routes names its app base, so its app-zone records cannot be found.",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads every page of a paginated list and fails on one that is cut short", () =>
    Effect.gen(function* () {
      const paged = pr2994World();
      paged.bucketPages = [
        ["executor-next-hosted-siteassets-v2-o6dtg2eht7y7rlwd", pr2994.appBuilds],
        [pr2994.siteAssets],
      ];
      paged.workflows = [
        ...Array.from({ length: 100 }, (_, index) => ({
          name: `executor-next-hosted-api-v2-dddddddddddddddd-${index}`,
          script_name: "executor-next-hosted-api-v2-dddddddddddddddd",
        })),
        { name: `${pr2994.api}-eae6c5ea`, script_name: pr2994.api },
      ];
      const found = yield* inventory(paged, "pr-2994");
      expect(found).toMatchObject({
        buckets: [pr2994.appBuilds, pr2994.siteAssets],
        workflows: [`${pr2994.api}-eae6c5ea`],
      });
      for (const kind of ["dns", "workers"]) {
        const cut = pr2994World();
        cut.partial = [kind];
        const result = yield* cli(cut, ["inventory", "pr-2994"]);
        expect(result.code, kind).not.toBe(0);
        expect(result.output, kind).toContain("returned only part of the list.");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "counts a record whose reads fail a while as readable, and a stage partly readable as an error",
    () =>
      Effect.gen(function* () {
        const transient = pr2994World();
        // More failures than Alchemy's client retries by itself, fewer than the CLI's retries add.
        transient.state["test-pr-2994"] = { Api: 7, AuthSecret: "readable" };
        expect((yield* inventory(transient, "pr-2994")).state).toEqual({
          records: 2,
          readable: true,
        });
        const mixed = pr2994World();
        mixed.state["test-pr-2994"] = { Api: "undecryptable", AuthSecret: "readable" };
        const result = yield* cli(mixed, ["inventory", "pr-2994"]);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("1 of test-pr-2994's 2 Alchemy records could not be read");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses records it cannot remove and Artifacts it has no token to read", () =>
    Effect.gen(function* () {
      const world = pr2994World();
      world.state["test-pr-2994"] = {
        Api: "undecryptable",
        DatabaseConnection: "undecryptable",
        SomethingNew: "undecryptable",
      };
      const result = yield* cli(world, ["inventory", "pr-2994"], { withoutArtifactsToken: true });
      expect(result.code, result.output).toBe(0);
      const found = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
        readonly blockers: ReadonlyArray<string>;
      };
      expect(found.blockers).toEqual([
        "test-pr-2994's records name PlanetScale resources (DatabaseConnection), which removal by name does not cover.",
        "test-pr-2994's records name resources removal by name does not know: SomethingNew.",
        "Set CLOUDFLARE_ARTIFACTS_TOKEN to a token with Artifacts Read; the test-stage token cannot read Artifacts. Removal by name cannot confirm it holds no repositories.",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses when Artifacts refuse its token, or a later page of namespaces fails", () =>
    Effect.gen(function* () {
      const blocker = (message: string) =>
        `${message} Removal by name cannot confirm it holds no repositories.`;
      const refused = yield* cli(pr2994World(), ["inventory", "pr-2994"], {
        env: { CLOUDFLARE_ARTIFACTS_TOKEN: "a-token-artifacts-refuse" },
      });
      expect(refused.code, refused.output).toBe(0);
      expect(JSON.parse(refused.stdout.slice(refused.stdout.indexOf("{"))).blockers).toEqual([
        blocker("Listing Artifacts namespaces returned HTTP 401."),
      ]);
      const failing = pr2994World();
      failing.faults.push({
        method: "GET",
        path: /\/artifacts\/namespaces\?.*cursor=/u,
        status: 500,
      });
      const later = yield* inventory(failing, "pr-2994");
      expect(later.blockers).toEqual([blocker("Listing Artifacts namespaces returned HTTP 500.")]);
      // The first page was read; only the later page failed, five times.
      expect(
        failing.requests.filter((request) => /artifacts\/namespaces\?.*cursor=/u.test(request)),
      ).toHaveLength(5);
      const repeating = pr2994World();
      repeating.repeatNamespaceCursor = true;
      const looped = yield* inventory(repeating, "pr-2994");
      expect(looped.blockers).toEqual([blocker("Listing Artifacts namespaces repeated a cursor.")]);
      expect(
        repeating.requests.filter((request) => request.includes("/artifacts/namespaces?")),
      ).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reads namespaces by cursor and repositories by page, for the stage's own name only",
    () =>
      Effect.gen(function* () {
        const world = pr2994World();
        // pr-39's namespace holds more than a page of repositories; pr-399's and production's are
        // decoys with repositories of their own.
        Object.assign(world.artifacts, {
          "executor-test-pr-39-apps": 60,
          "executor-test-pr-399-apps": 0,
        });
        world.artifacts["executor-v2-apps"] = 7;
        const full = yield* inventory(world, "pr-39");
        expect(full.artifacts).toEqual({
          namespace: "executor-test-pr-39-apps",
          exists: true,
          repositories: 60,
        });
        expect(full.blockers).toEqual([
          "Artifacts namespace executor-test-pr-39-apps holds 60 repositories, which removal by name does not delete.",
        ]);
        const empty = yield* inventory(world, "pr-399");
        expect(empty).toMatchObject({
          artifacts: { namespace: "executor-test-pr-399-apps", exists: true, repositories: 0 },
          blockers: [],
        });
        const never = yield* inventory(world, "pr-3999");
        expect(never).toMatchObject({
          artifacts: { namespace: "executor-test-pr-3999-apps", exists: false, repositories: 0 },
          blockers: [],
        });
        const untotalled = pr2994World();
        untotalled.repositoriesWithoutTotal = true;
        untotalled.artifacts["executor-test-pr-2994-apps"] = 60;
        expect((yield* inventory(untotalled, "pr-2994")).blockers).toEqual([
          "Listing Artifacts namespace executor-test-pr-2994-apps returned only part of the list. Removal by name cannot confirm it holds no repositories.",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

/** These run on the real clock: they wait for Postgres and for the CLI's retries. */
describe("Removing a test stage by name, with its registry", () => {
  it.live(
    "removes the stage in order, retrying 429 and 5xx, and deletes its records only after an empty check",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = pr2994World();
        yield* prepareRegistry(world, url);
        yield* psql(lease("pr-2994"));
        world.faults.push(
          {
            method: "DELETE",
            path: /\/workers\/scripts\//u,
            status: 429,
            headers: { "retry-after": "1" },
            times: 1,
          },
          { method: "DELETE", path: /\/workflows\//u, status: 503, times: 2 },
        );
        const before = world.requests.length;
        const result = yield* cli(world, ["destroy", "pr-2994", "--by-name", "--yes"], {
          registry: url,
        });
        expect(result.code, result.output).toBe(0);
        const order = deletes({ ...world, requests: world.requests.slice(before) }).map((request) =>
          request.replace(/\?.*$/u, ""),
        );
        const first = (fragment: string) =>
          order.findIndex((request) => request.includes(fragment));
        // App-zone DNS first, then the Workers, then what is found by their names.
        expect(first("/dns_records/dns-team")).toBe(0);
        expect(first("/workers/scripts/")).toBeGreaterThan(first("/dns_records/dns-team-host"));
        expect(first("/workers/routes/")).toBeGreaterThan(first("/workers/scripts/"));
        expect(first("/workflows/")).toBeGreaterThan(first("/workers/scripts/"));
        expect(order.at(-1)).toBe("DELETE /state/stacks/executor-next-hosted");
        expect(
          order.filter((request) => request.includes(`/workers/scripts/${pr2994.api}`)).length +
            order.filter((request) => request.includes(`/workers/scripts/${pr2994.pages}`)).length,
        ).toBe(3);
        expect(order.filter((request) => request.includes("/workflows/"))).toHaveLength(3);
        // Everything of the stage is gone and nothing else is.
        expect(world.workers.map((worker) => worker.id)).not.toContain(pr2994.api);
        expect(world.workers).toHaveLength(5);
        expect(Object.keys(world.buckets)).toHaveLength(3);
        expect(world.dns[appZone.id]!.map((record) => record.id)).toEqual([
          "dns-production-team",
          "dns-neighbour-team",
        ]);
        expect(world.routes[otherZone.id]).toEqual([]);
        expect(world.state["test-pr-2994"]).toEqual({});
        expect(
          yield* psql("select count(*) from executor_test_stage_leases where slug = 'pr-2994'"),
        ).toBe("0\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "keeps the records after a partial run and finishes on the rerun",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = pr2994World();
        yield* prepareRegistry(world, url);
        yield* psql(lease("pr-2994"));
        // Every attempt at the first bucket is refused, so the run stops there.
        world.faults.push({
          method: "DELETE",
          path: /\/r2\/buckets\/[^/]+$/u,
          status: 403,
          times: 4,
        });
        const failedRun = yield* cli(world, ["destroy", "pr-2994", "--by-name", "--yes"], {
          registry: url,
        });
        expect(failedRun.code).not.toBe(0);
        expect(failedRun.output).toContain("returned HTTP 403");
        // The Workers and routes went; the records and the registry entry stay.
        expect(world.workers.map((worker) => worker.id)).not.toContain(pr2994.pages);
        expect(Object.keys(world.state["test-pr-2994"]!)).toHaveLength(3);
        expect(
          yield* psql("select count(*) from executor_test_stage_leases where slug = 'pr-2994'"),
        ).toBe("1\n");
        const rerun = yield* cli(world, ["destroy", "pr-2994", "--by-name", "--yes"], {
          registry: url,
        });
        expect(rerun.code, rerun.output).toBe(0);
        expect(Object.keys(world.buckets)).toHaveLength(3);
        expect(world.state["test-pr-2994"]).toEqual({});
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "keeps the records when the check after removal cannot list",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = pr2994World();
        yield* prepareRegistry(world, url);
        yield* psql(lease("pr-2994"));
        // The stage's 18 deletions all succeed; only the check after them cannot list.
        world.faults.push({ method: "GET", path: /\/v2\/tokens$/u, status: 500, afterDeletes: 18 });
        const result = yield* cli(world, ["destroy", "pr-2994", "--by-name", "--yes"], {
          registry: url,
        });
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("Listing Axiom tokens returned HTTP 500.");
        expect(Object.keys(world.state["test-pr-2994"]!)).toHaveLength(3);
        expect(deletes(world).some((request) => request.startsWith("DELETE /state/"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "refuses PlanetScale and stages without a registry entry, and needs --by-name",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = pr2994World();
        yield* prepareRegistry(world, url);
        const unregistered = yield* cli(world, ["destroy", "pr-2994", "--by-name", "--yes"], {
          registry: url,
        });
        expect(unregistered.code).not.toBe(0);
        expect(unregistered.output).toContain("test-pr-2994 has no record in the registry");
        yield* psql(lease("pr-2994", "planetscale"));
        const planetscale = yield* cli(world, ["destroy", "pr-2994", "--by-name", "--yes"], {
          registry: url,
        });
        expect(planetscale.code).not.toBe(0);
        expect(planetscale.output).toContain("test-pr-2994 uses PlanetScale");
        const plain = yield* cli(world, ["destroy", "pr-2994", "--yes"], { registry: url });
        expect(plain.code).not.toBe(0);
        expect(plain.output).toContain("bun run test-stage destroy pr-2994 --by-name --yes");
        expect(deletes(world)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "an eviction that meets an unreadable stage fails visibly and removes nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { url, psql } = yield* registry;
        const world = pr2994World();
        yield* prepareRegistry(world, url);
        // The oldest of 80 stages, owned by someone whose name breaks a workflow command.
        yield* psql(
          lease("pr-2994", "neon", "2026-10-01T00:00:00Z", "Owner 100%\r\n::error::spoof"),
        );
        yield* psql(
          `insert into executor_test_stage_leases (slug, owner, created_at, expires_at, database_provider, retention, background)
         select 'filler-' || n, 'Filler', '2026-11-01'::timestamptz + n * interval '1 minute', null, 'neon', 'retained', 'active'
         from generate_series(1, 79) as n`,
        );
        // The deploy stops at its first build step, after eviction.
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-stage-evict-" });
        const bin = path.join(directory, "bin");
        yield* fs.makeDirectory(bin);
        for (const tool of ["bun", "alchemy"]) {
          yield* fs.writeFileString(path.join(bin, tool), "#!/bin/sh\nexit 1\n");
          yield* fs.chmod(path.join(bin, tool), 0o755);
        }
        const summary = path.join(directory, "summary.md");
        yield* fs.writeFileString(summary, "");
        const result = yield* cli(
          world,
          ["deploy", "new-stage", "--owner", "Deployer", "--no-input", "--yes"],
          {
            registry: url,
            env: {
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              GITHUB_ACTIONS: "true",
              GITHUB_STEP_SUMMARY: summary,
            },
          },
        );
        expect(result.code).not.toBe(0);
        const warning = result.stdout.split("\n").find((line) => line.startsWith("::warning"));
        expect(warning).toContain("Could not evict pr-2994 (Owner 100%25%0D%0A::error::spoof)");
        expect(warning).toContain("destroy pr-2994 --by-name --yes");
        expect(result.output.split(/\r?\n|\r/u).some((line) => line.startsWith("::error::"))).toBe(
          false,
        );
        const written = yield* fs.readFileString(summary);
        expect(written).toContain("**Test stage not evicted:** Could not evict pr-2994");
        expect(written).not.toContain(account);
        expect(deletes(world)).toEqual([]);
        expect(
          yield* psql("select count(*) from executor_test_stage_leases where slug = 'pr-2994'"),
        ).toBe("1\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  /**
   * `deploy` with `stages` other test stages already leased, pr-2994 the oldest. The build tools
   * are stubs that leave a mark when they run and then fail, so the deploy stops at its first build
   * step, after its eviction decision: the mark says whether it got that far. An eviction's own
   * `alchemy destroy` succeeds. pr-2994's records are
   * unreadable unless `readable`, so evicting it fails unless they are.
   */
  const deployAmong = (
    stages: number,
    flags: ReadonlyArray<string>,
    {
      readable = false,
      namespaces = [],
      namespacesUnlisted = 0,
      workers = 0,
      env = {},
    }: {
      readonly readable?: boolean;
      readonly namespaces?: Array<{ script: string }>;
      readonly namespacesUnlisted?: number;
      /** More production Workers, which no test stage owns, beside the world's 7. */
      readonly workers?: number;
      readonly env?: Record<string, string>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { url, psql } = yield* registry;
      const world = pr2994World();
      world.namespaces = namespaces;
      world.namespacesUnlisted = namespacesUnlisted;
      for (let index = 0; index < workers; index += 1)
        world.workers.push({
          id: `executor-next-hosted-worker${index}-v2-ffffffffffffffff`,
          tags: tags("v2", `Worker${index}`),
        });
      if (readable)
        world.state["test-pr-2994"] = {
          Api: "readable",
          AppPages: "readable",
          AuthSecret: "readable",
        };
      yield* prepareRegistry(world, url);
      yield* psql(lease("pr-2994", "neon", "2026-10-01T00:00:00Z", "Owner"));
      yield* psql(
        `insert into executor_test_stage_leases (slug, owner, created_at, expires_at, database_provider, retention, background)
         select 'filler-' || n, 'Filler', '2026-11-01'::timestamptz + n * interval '1 minute', null, 'neon', 'retained', 'active'
         from generate_series(1, ${stages - 1}) as n`,
      );
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-stage-no-evict-" });
      const bin = path.join(directory, "bin");
      const built = path.join(directory, "built");
      yield* fs.makeDirectory(bin);
      // An eviction's `alchemy destroy` succeeds; any other call is a build step, which fails.
      for (const tool of ["bun", "alchemy"]) {
        yield* fs.writeFileString(
          path.join(bin, tool),
          `#!/bin/sh\n${tool === "alchemy" ? 'if [ "$1" = destroy ]; then exit 0; fi\n' : ""}touch '${built}'\nexit 1\n`,
        );
        yield* fs.chmod(path.join(bin, tool), 0o755);
      }
      const result = yield* cli(
        world,
        ["deploy", "new-stage", "--owner", "Deployer", "--no-input", "--yes", ...flags],
        { registry: url, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env } },
      );
      return {
        result,
        built: yield* fs.exists(built),
        deletes: deletes(world),
        leases: (yield* psql("select count(*) from executor_test_stage_leases")).trim(),
        oldest: (yield* psql(
          "select count(*) from executor_test_stage_leases where slug = 'pr-2994'",
        )).trim(),
      };
    });

  it.live(
    "with --no-evict, a deploy that would evict a stage refuses before it reserves, builds or destroys anything, naming the stage",
    () =>
      Effect.gen(function* () {
        const { result, built, deletes, leases, oldest } = yield* deployAmong(80, ["--no-evict"]);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("Deploying new-stage would evict 1 test stage");
        expect(result.output).toContain("pr-2994 (Owner)");
        expect(result.output).not.toContain("Evicting the oldest test stage");
        expect([built, deletes, leases, oldest]).toEqual([false, [], "80", "1"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "with --no-evict, a deploy that evicts nothing goes on as before",
    () =>
      Effect.gen(function* () {
        const { result, built, deletes, oldest } = yield* deployAmong(79, ["--no-evict"]);
        // It reaches the first build step, whose stub fails.
        expect(result.output).not.toContain("would evict");
        expect(result.output).not.toContain("Evicting the oldest test stage");
        expect([built, deletes, oldest]).toEqual([true, [], "1"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "without --no-evict, a deploy at the limit tries to evict the oldest stage, as before",
    () =>
      Effect.gen(function* () {
        const { result, built } = yield* deployAmong(80, []);
        expect(result.output).toContain(
          "Evicting the oldest test stage, pr-2994 (Owner), to stay within 80.",
        );
        expect(result.output).not.toContain("would evict");
        expect(built).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "without --no-evict, a deploy at the limit removes a readable oldest stage and stays within 80",
    () =>
      Effect.gen(function* () {
        const { result, built, leases, oldest } = yield* deployAmong(80, [], { readable: true });
        expect(result.output).toContain("Evicted pr-2994.");
        expect(result.output).not.toContain("Could not evict");
        expect([built, oldest, leases]).toEqual([true, "0", "80"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  /**
   * The account's Durable Object namespaces: `stage` of them exported by pr-2994's API Worker, and
   * `others` by production's, which no test stage owns.
   */
  const namespaces = (stage: number, others: number) => [
    ...Array.from({ length: stage }, () => ({ script: pr2994.api })),
    ...Array.from({ length: others }, () => ({
      script: "executor-next-hosted-api-v2-dddddddddddddddd",
    })),
  ];

  const classLimit = "TEST_STAGE_DURABLE_OBJECT_CLASS_LIMIT";
  const workerLimit = "TEST_STAGE_WORKER_LIMIT";
  /** 497 namespaces over two pages; a stage holds up to 8, so a new one would make 505. */
  const pastClasses =
    "Deploying new-stage brings the account to about 505 Durable Object namespaces (497 now, up to 8 for a test stage), past Cloudflare's documented limit of 500 Durable Object classes per Workers Paid account. This account's real limit is unknown and may have been raised, so the deploy goes on; if it is lower, the deploy fails part way through. Set TEST_STAGE_DURABLE_OBJECT_CLASS_LIMIT to the account's limit to refuse such a deploy instead.";

  it.live(
    "past Cloudflare's documented class quota with no limit configured, a new stage warns once and deploys",
    () =>
      Effect.gen(function* () {
        const { result, built } = yield* deployAmong(10, [], { namespaces: namespaces(8, 489) });
        expect(result.output).toContain(pastClasses);
        expect(result.output.split(pastClasses).length - 1).toBe(1);
        expect(result.output).not.toContain("Workers per Workers Paid account");
        expect(built).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "past a configured class limit, a new stage is refused before it evicts, reserves or builds anything",
    () =>
      Effect.gen(function* () {
        const { result, built, deletes, leases } = yield* deployAmong(10, [], {
          namespaces: namespaces(8, 489),
          env: { [classLimit]: "500" },
        });
        expect(result.code).not.toBe(0);
        expect(result.output).toContain(
          "Deploying new-stage would bring the account to about 505 Durable Object namespaces (497 now, up to 8 for a test stage), over the TEST_STAGE_DURABLE_OBJECT_CLASS_LIMIT limit of 500 Durable Object classes. Nothing was evicted, reserved, deployed or destroyed. Destroy test stages you own, or redeploy one instead of a new slug.",
        );
        expect(result.output).not.toContain("past Cloudflare's documented limit");
        expect([built, deletes, leases]).toEqual([false, [], "10"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "past Cloudflare's documented Workers quota with no limit configured, a new stage warns and deploys",
    () =>
      Effect.gen(function* () {
        // The world's 7 Workers and 492 more make 499; pr-2994 has 2, so a new stage would make 501.
        const { result, built } = yield* deployAmong(10, [], { workers: 492 });
        expect(result.output).toContain(
          "Deploying new-stage brings the account to about 501 Workers (499 now, up to 2 for a test stage), past Cloudflare's documented limit of 500 Workers per Workers Paid account. This account's real limit is unknown and may have been raised, so the deploy goes on; if it is lower, the deploy fails part way through. Set TEST_STAGE_WORKER_LIMIT to the account's limit to refuse such a deploy instead.",
        );
        expect(result.output).not.toContain("Durable Object namespaces");
        expect(built).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "past a configured Workers limit, a new stage is refused, and one message names every limit it passes",
    () =>
      Effect.gen(function* () {
        const workersOnly = yield* deployAmong(10, [], {
          workers: 492,
          env: { [workerLimit]: "500" },
        });
        expect(workersOnly.result.code).not.toBe(0);
        expect(workersOnly.result.output).toContain(
          "Deploying new-stage would bring the account to about 501 Workers (499 now, up to 2 for a test stage), over the TEST_STAGE_WORKER_LIMIT limit of 500 Workers. Nothing was evicted, reserved, deployed or destroyed.",
        );
        expect([workersOnly.built, workersOnly.leases]).toEqual([false, "10"]);
        const both = yield* deployAmong(10, [], {
          namespaces: namespaces(8, 489),
          workers: 492,
          env: { [classLimit]: "500", [workerLimit]: "500" },
        });
        expect(both.result.output).toContain(
          "Deploying new-stage would bring the account to about 505 Durable Object namespaces (497 now, up to 8 for a test stage), over the TEST_STAGE_DURABLE_OBJECT_CLASS_LIMIT limit of 500 Durable Object classes; and to about 501 Workers (499 now, up to 2 for a test stage), over the TEST_STAGE_WORKER_LIMIT limit of 500 Workers.",
        );
        expect(both.built).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a new stage within the documented quotas, or within configured limits above them, deploys without a word",
    () =>
      Effect.gen(function* () {
        const fits = yield* deployAmong(10, [], { namespaces: namespaces(8, 484), workers: 491 });
        expect(fits.result.output).not.toContain("Durable Object namespaces");
        expect(fits.result.output).not.toContain("Workers (");
        expect(fits.built).toBe(true);
        const raised = yield* deployAmong(10, [], {
          namespaces: namespaces(8, 489),
          workers: 492,
          env: { [classLimit]: "505", [workerLimit]: "1000" },
        });
        expect(raised.result.output).not.toContain("Durable Object namespaces");
        expect(raised.result.output).not.toContain("Workers (");
        expect(raised.built).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "the namespaces of a stage the deploy evicts count as freed",
    () =>
      Effect.gen(function* () {
        // pr-2994's 8 go with it, so the new stage brings the account back to 497.
        const { result, built, oldest } = yield* deployAmong(80, [], {
          readable: true,
          namespaces: namespaces(8, 489),
          env: { [classLimit]: "500" },
        });
        expect(result.output).not.toContain("Durable Object namespaces");
        expect(result.output).toContain("Evicted pr-2994.");
        expect([built, oldest]).toEqual([true, "0"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a stage whose eviction fails frees nothing: past a configured limit the deploy stops before it reserves or builds",
    () =>
      Effect.gen(function* () {
        // pr-2994's records are unreadable, so its eviction fails and its 8 stay: 505 would pass 500.
        const { result, built, leases, oldest } = yield* deployAmong(80, [], {
          namespaces: namespaces(8, 489),
          env: { [classLimit]: "500" },
        });
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("Could not evict pr-2994");
        expect(result.output).toContain(
          "Deploying new-stage would bring the account to about 505 Durable Object namespaces (497 now, up to 8 for a test stage), over the TEST_STAGE_DURABLE_OBJECT_CLASS_LIMIT limit of 500 Durable Object classes. An eviction failed, so this deploy stopped; nothing was reserved or deployed.",
        );
        expect([built, leases, oldest]).toEqual([false, "80", "1"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a stage whose eviction fails frees nothing: with no limit configured the deploy warns and goes on",
    () =>
      Effect.gen(function* () {
        // Before the eviction pr-2994's 8 count as freed, so nothing warns; once it fails, 505 does.
        const { result, built } = yield* deployAmong(80, [], { namespaces: namespaces(8, 489) });
        expect(result.output).toContain("Could not evict pr-2994");
        expect(result.output).toContain(pastClasses);
        expect(
          result.output.indexOf(pastClasses) > result.output.indexOf("Could not evict pr-2994"),
        ).toBe(true);
        expect(built).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a namespace listing that ends before the total it states is not taken as the count",
    () =>
      Effect.gen(function* () {
        // 300 fit and 300 more are claimed but never listed: counting 300 would wave it through.
        const { result, built, leases } = yield* deployAmong(10, [], {
          namespaces: namespaces(8, 292),
          namespacesUnlisted: 300,
        });
        expect(result.code).not.toBe(0);
        expect(result.output).toContain(
          "Could not count the account's Workers and Durable Object namespaces, so a new test stage was not started.",
        );
        expect([built, leases]).toEqual([false, "10"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a new stage is not started when the namespaces cannot be counted",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = pr2994World();
        world.faults.push({
          method: "GET",
          path: /\/workers\/durable_objects\/namespaces/u,
          status: 403,
        });
        yield* prepareRegistry(world, url);
        const result = yield* cli(
          world,
          ["deploy", "new-stage", "--owner", "Deployer", "--no-input", "--yes"],
          { registry: url },
        );
        expect(result.code).not.toBe(0);
        expect(result.output).toContain(
          "Could not count the account's Workers and Durable Object namespaces, so a new test stage was not started.",
        );
        expect(deletes(world)).toEqual([]);
        expect((yield* psql("select count(*) from executor_test_stage_leases")).trim()).toBe("0");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "plan takes no --no-evict: it is refused as an unknown flag, before anything is read or reserved",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = pr2994World();
        yield* prepareRegistry(world, url);
        yield* psql(lease("pr-2994"));
        const result = yield* cli(
          world,
          ["plan", "new-stage", "--owner", "Deployer", "--no-input", "--no-evict"],
          { registry: url },
        );
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("Unrecognized flag: --no-evict in command test-stage plan");
        expect(deletes(world)).toEqual([]);
        expect((yield* psql("select count(*) from executor_test_stage_leases")).trim()).toBe("1");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );
});

/**
 * A new stage's `alchemy deploy` that fails only because its Hyperdrive config could not reach the
 * new database yet is run once more (`test-stage-deploy-retry.ts`). The build tools are stubs that succeed; `alchemy`
 * prints each attempt's recorded output and exits with its status, and counts its runs; `/health`
 * on the stage's hosts answers `ok` in the CLI process, so a deploy that succeeds finishes.
 */
describe("Retrying a new stage's deploy", () => {
  const colour = (text: string) => `\u001b[31m${text}\u001b[39m`;
  const line = (text: string) => `[01:48:25.603] INFO (#1): ${text}`;
  /** The Durable Object tag race, which the Alchemy patch handles and the retry does not. */
  const durableObjectTags = [
    line(
      "[AppDataSupervisor] fail — Cannot apply new-sqlite-class migration to class 'AppDataSupervisor' that is already depended on by existing Durable Objects. [code: 10074] (15.2s)",
    ),
    line(
      "[AppOutboundRelay] fail — Cannot apply new-sqlite-class migration to class 'AppOutboundRelay' that is already depended on by existing Durable Objects. [code: 10074] (15.2s)",
    ),
    line(""),
    line("Failed: 44 succeeded, 2 failed (2m 41s)"),
  ].join("\n");
  /** As run 44655804399 printed it, with Alchemy's colours on the config's own line. */
  const hyperdriveOrigin = (took: string) =>
    [
      line("[DatabaseConnection] creating"),
      line(
        "[McpServer] fail — BadRequest: Network connection to the provided database timed out. (158.0s)",
      ),
      line(
        "[AppDomains] fail — BadRequest: Network connection to the provided database timed out.",
      ),
      line(
        "[Api] fail — BadRequest: Network connection to the provided database timed out. (158.0s)",
      ),
      line(
        `[DatabaseConnection] ${colour("fail")} — ${colour("BadRequest: Network connection to the provided database timed out.")} (${took})`,
      ),
      line(""),
      line(`${colour("Failed:")} 41 succeeded, 4 failed (158.6s)`),
    ].join("\n");
  const succeeded = [
    line("[Api] updated (20.1s)"),
    line(""),
    line("Done: 46 succeeded (31.0s)"),
  ].join("\n");
  interface Attempt {
    readonly output: string;
    readonly code: number;
  }
  /** Deploy `slug` with `alchemy` answering `attempts` in turn; a further run exits 99. */
  const deployAttempts = (url: string, slug: string, attempts: ReadonlyArray<Attempt>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-stage-retry-" });
      const bin = path.join(directory, "bin");
      const runs = path.join(directory, "runs");
      yield* fs.makeDirectory(bin);
      // The packed apps' version names the directory the CLI writes under `.local/stage-apps`.
      const version = `0.0.0-deploy-retry-${randomBytes(4).toString("hex")}`;
      const stageApps = path.resolve(".local/stage-apps");
      yield* Effect.addFinalizer(() =>
        fs.readDirectory(stageApps).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((entry) => entry.startsWith(`apps-${version}-`)),
              (entry) => fs.remove(path.join(stageApps, entry), { recursive: true }),
              { discard: true },
            ),
          ),
          Effect.ignore,
        ),
      );
      for (const [index, attempt] of attempts.entries()) {
        yield* fs.writeFileString(path.join(directory, `attempt-${index + 1}.out`), attempt.output);
        yield* fs.writeFileString(
          path.join(directory, `attempt-${index + 1}.code`),
          `${attempt.code}`,
        );
      }
      const tools = {
        bun: "#!/bin/sh\nexit 0\n",
        tar: `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = -C ]; then out="$2"; fi; shift; done\nmkdir -p "$out/package"\nprintf '%s' '{"version":"${version}"}' > "$out/package/package.json"\n`,
        alchemy: `#!/bin/sh\nn=$(( $(cat '${runs}' 2>/dev/null || echo 0) + 1 ))\necho $n > '${runs}'\ncat '${directory}/attempt-'$n.out 2>/dev/null\necho 'Cloudflare Worker startup summary: 0 upload attempts.' >&2\nexit $(cat '${directory}/attempt-'$n.code 2>/dev/null || echo 99)\n`,
      };
      for (const [tool, script] of Object.entries(tools)) {
        yield* fs.writeFileString(path.join(bin, tool), script);
        yield* fs.chmod(path.join(bin, tool), 0o755);
      }
      const health = path.join(directory, "health.mjs");
      yield* fs.writeFileString(
        health,
        `const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const host = url.hostname === "${slug}.executor.engineering" || url.hostname.endsWith(".${slug}.executor.engineering");
  return url.pathname === "/health" && host
    ? Promise.resolve(Response.json({ status: "ok" }))
    : real(input, init);
};
`,
      );
      const result = yield* cli(
        pr2994World(),
        ["deploy", slug, "--owner", "Deployer", "--no-input", "--yes"],
        {
          registry: url,
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            NODE_OPTIONS: `--import=${health}`,
            TEST_STAGE_DEPLOY_RETRY_WAIT: "10 millis",
          },
        },
      );
      const ran = yield* fs.readFileString(runs).pipe(Effect.orElseSucceed(() => "0"));
      return {
        result,
        runs: Number(ran.trim()),
        retries: result.output.split("Retrying the deploy once").length - 1,
      };
    }).pipe(Effect.scoped);

  it.live(
    "a new stage whose Hyperdrive config cannot reach its new database yet waits, then deploys once more",
    () =>
      Effect.gen(function* () {
        const { url } = yield* registry;
        const { result, runs, retries } = yield* deployAttempts(url, "retry-hyperdrive", [
          { output: hyperdriveOrigin("12.8s"), code: 1 },
          { output: succeeded, code: 0 },
        ]);
        expect(result.code, result.output).toBe(0);
        expect([runs, retries]).toEqual([2, 1]);
        expect(result.output).toContain(
          "Retrying the deploy once (hyperdrive-origin): its first attempt failed only because Hyperdrive config DatabaseConnection could not reach the new database's pooled origin; waiting 10ms first.",
        );
        expect(result.output).toContain("Ready: https://retry-hyperdrive.executor.engineering");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a retried deploy that fails again stops after its second attempt, with both attempts' output",
    () =>
      Effect.gen(function* () {
        const { url } = yield* registry;
        const { result, runs, retries } = yield* deployAttempts(url, "retry-twice", [
          { output: hyperdriveOrigin("12.8s"), code: 1 },
          { output: hyperdriveOrigin("9.7s"), code: 1 },
        ]);
        expect(result.code).not.toBe(0);
        expect([runs, retries]).toEqual([2, 1]);
        for (const took of ["12.8s", "9.7s"])
          expect(result.output).toContain(
            `BadRequest: Network connection to the provided database timed out.\u001b[39m (${took})`,
          );
        expect(result.output).toContain("The child command exited with status 1.");
        expect(result.output).not.toContain("Ready:");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a deploy that fails otherwise, with the Durable Object tag race, or with the signature beside another failure, is not retried",
    () =>
      Effect.gen(function* () {
        const { url } = yield* registry;
        const unrelated = [
          line("[AuthSecret] fail — Unauthorized: Authentication error [code: 10000] (0.4s)"),
          line("Failed: 50 succeeded, 1 failed (40.0s)"),
        ].join("\n");
        const mixed = [
          line(
            "[DatabaseConnection] fail — BadRequest: Network connection to the provided database timed out. (12.8s)",
          ),
          line("[Edge] fail — Unauthorized: Authentication error [code: 10000] (0.4s)"),
          line("Failed: 49 succeeded, 2 failed (40.0s)"),
        ].join("\n");
        // A signature in a failed resource's message, but a summary that counts another failure.
        const uncounted = [
          line(
            "[DatabaseConnection] fail — BadRequest: Network connection to the provided database timed out. (12.8s)",
          ),
          line("Failed: 49 succeeded, 2 failed (40.0s)"),
        ].join("\n");
        // A signature's text with no summary: Alchemy stopped before or outside its apply.
        const unfinished = line(
          "[DatabaseConnection] fail — BadRequest: Network connection to the provided database timed out. (12.8s)",
        );
        for (const [slug, output] of [
          ["retry-unrelated", unrelated],
          // The Alchemy patch on main handles this race; the retry does not.
          ["retry-durable-object", durableObjectTags],
          ["retry-mixed", mixed],
          ["retry-uncounted", uncounted],
          ["retry-unfinished", unfinished],
          ["retry-silent", ""],
        ] as const) {
          const { result, runs, retries } = yield* deployAttempts(url, slug, [
            { output, code: 1 },
            { output: succeeded, code: 0 },
          ]);
          expect(result.code, slug).not.toBe(0);
          expect([slug, runs, retries]).toEqual([slug, 1, 0]);
          expect(result.output).toContain("The child command exited with status 1.");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "a redeploy of an existing stage whose Hyperdrive config cannot reach its database is not retried",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        yield* prepareRegistry(pr2994World(), url);
        yield* psql(lease("retry-existing"));
        const { result, runs, retries } = yield* deployAttempts(url, "retry-existing", [
          { output: hyperdriveOrigin("12.8s"), code: 1 },
          { output: succeeded, code: 0 },
        ]);
        expect(result.code).not.toBe(0);
        expect([runs, retries]).toEqual([1, 0]);
        expect(result.output).toContain(
          "[DatabaseConnection] \u001b[31mfail\u001b[39m — \u001b[31mBadRequest: Network connection to the provided database timed out.",
        );
        expect(result.output).toContain("The child command exited with status 1.");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );
});

/**
 * A deployed E2E stage on PlanetScale whose deploy stopped before Alchemy recorded its branch: the
 * stage's Alchemy destroy (a stand-in that succeeds and deletes nothing) leaves the branch, and
 * `test-stage destroy` then removes it by its exact name, keeping the stage's lease unless
 * PlanetScale answers 404 (`test-stage-branch.ts`). The same holds for scheduled cleanup.
 */
describe("Removing a branch a PlanetScale stage's destroy left", () => {
  const leftWorld = (slug: string, deleteStatus: number): World => ({
    workers: [],
    zones: [testZone, appZone, otherZone],
    routes: {},
    domains: [],
    workflows: [],
    buckets: {},
    dns: {},
    destinations: [],
    hyperdrive: [],
    certificates: [],
    artifacts: {},
    branches: [],
    monitors: [],
    tokens: [],
    state: { [`test-${slug}`]: { Api: "readable", PreviewDatabase: "readable" } },
    faults: [],
    planetscale: {
      [`test-${slug}`]: { production: false, deleteStatus },
      // Never touched: production, the index-lock branch, a name that starts with the stage's.
      main: { production: true, deleteStatus: 500 },
      "idx-lock-38132096340-1": { production: true, deleteStatus: 500 },
      [`test-${slug}-copy`]: { production: false, deleteStatus: 500 },
    },
    requests: [],
  });
  const planetscaleEnv = (bin: string) => ({
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TEST_STAGE_DATABASE: "executor-test",
    PLANETSCALE_ORGANIZATION: "synthetic-org",
    PLANETSCALE_API_TOKEN_ID: "synthetic-id",
    PLANETSCALE_API_TOKEN: "synthetic-token",
    TEST_STAGE_BRANCH_POLL: "10 millis",
  });
  /** A directory whose `alchemy` succeeds and does nothing, as a destroy that left the branch. */
  const quietAlchemy = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-stage-branch-" });
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "alchemy"), "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(path.join(bin, "alchemy"), 0o755);
    return bin;
  });
  const planetscaleRequests = (world: World) =>
    world.requests.filter((request) => request.includes("/v1/organizations/"));
  const leaseCount = (psql: (sql: string) => Effect.Effect<string, unknown>, slug: string) =>
    psql(`select count(*) from executor_test_stage_leases where slug = '${slug}'`);
  /** A temporary PlanetScale lease created at `createdAt`; it expires 3 hours later. */
  const planetscaleLease = (slug: string, createdAt: string) =>
    `insert into executor_test_stage_leases (slug, owner, created_at, expires_at, database_provider, retention, background)
     values ('${slug}', 'CI', '${createdAt}', '${createdAt}'::timestamptz + interval '3 hours', 'planetscale', 'temporary', 'active')`;

  it.live(
    "destroy deletes the left branch by its exact name, and only then removes the lease",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = leftWorld("e2e-left1", 204);
        yield* prepareRegistry(world, url);
        yield* psql(planetscaleLease("e2e-left1", "2099-01-01T00:00:00Z"));
        const bin = yield* quietAlchemy;
        const result = yield* cli(world, ["destroy", "e2e-left1", "--no-input", "--yes"], {
          registry: url,
          env: planetscaleEnv(bin),
        });
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain(
          "PlanetScale branch test-e2e-left1 was left by the destroy; a delete was sent (PlanetScale answered 204) and it is gone (404).",
        );
        const branch =
          "/v1/organizations/synthetic-org/databases/executor-test/branches/test-e2e-left1";
        expect(
          planetscaleRequests(world).filter((request) => request.startsWith("DELETE ")),
        ).toEqual([`DELETE ${branch}`]);
        expect(Object.keys(world.planetscale!).toSorted()).toEqual([
          "idx-lock-38132096340-1",
          "main",
          "test-e2e-left1-copy",
        ]);
        expect(yield* leaseCount(psql, "e2e-left1")).toBe("0\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "destroy keeps the lease when the delete is refused, and says so",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = leftWorld("e2e-left2", 403);
        yield* prepareRegistry(world, url);
        yield* psql(planetscaleLease("e2e-left2", "2099-01-01T00:00:00Z"));
        const bin = yield* quietAlchemy;
        const result = yield* cli(world, ["destroy", "e2e-left2", "--no-input", "--yes"], {
          registry: url,
          env: planetscaleEnv(bin),
        });
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(
          "PlanetScale branch test-e2e-left2 was left by the destroy. A delete was sent and PlanetScale refused it (403). Its stage lease is kept",
        );
        expect(yield* leaseCount(psql, "e2e-left2")).toBe("1\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  it.live(
    "scheduled cleanup retries a due lease's left branch and keeps the lease it could not finish",
    () =>
      Effect.gen(function* () {
        const { url, psql } = yield* registry;
        const world = leftWorld("e2e-left3", 403);
        yield* prepareRegistry(world, url);
        // Past its cleanup deadline.
        yield* psql(planetscaleLease("e2e-left3", "2026-11-16T01:00:00Z"));
        const bin = yield* quietAlchemy;
        const result = yield* cli(world, ["cleanup"], { registry: url, env: planetscaleEnv(bin) });
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(
          "Cleanup failed for e2e-left3; its lease remains for retry. PlanetScale branch test-e2e-left3 was left by the destroy. A delete was sent and PlanetScale refused it (403).",
        );
        expect(
          planetscaleRequests(world).filter((request) => request.startsWith("DELETE ")),
        ).toEqual([
          "DELETE /v1/organizations/synthetic-org/databases/executor-test/branches/test-e2e-left3",
        ]);
        expect(yield* leaseCount(psql, "e2e-left3")).toBe("1\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );
});
