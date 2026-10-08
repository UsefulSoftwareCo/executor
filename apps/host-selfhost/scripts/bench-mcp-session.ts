import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Layer, Tracer } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import { makeMcpBuildServer, makeScopedExecutor, PluginsProvider } from "@executor-js/api/server";
import { createSelfHostDb, SelfHostDb } from "../src/db/self-host-db";
import { SelfHostExecutionStackLayer, SelfHostScopedExecutorSeams } from "../src/execution";
import type { SelfHostPlugins } from "../src/plugins";
import executorConfig from "../executor.config";

const dataDir = mkdtempSync(join(tmpdir(), "executor-session-bench-"));
process.env.EXECUTOR_DATA_DIR = dataDir;
const db = await createSelfHostDb({ path: join(dataDir, "data.db") });
const dbLayer = Layer.succeed(SelfHostDb)(db);
const samples = Number(process.env.BENCH_SAMPLES ?? 25);
const phases: Record<string, number[]> = {};
const record = (name: string, ms: number) => (phases[name] ??= []).push(ms);
const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    span.end = (time, exit) => {
      record(options.name, Number(time - options.startTime) / 1e6);
      end(time, exit);
    };
    return span;
  },
});
const pluginsLayer = Layer.succeed(PluginsProvider)({
  plugins(context) {
    const start = performance.now();
    const plugins = executorConfig.plugins({
      activeToolkitSlug:
        context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
    });
    record("plugins.factory", performance.now() - start);
    return plugins;
  },
});
const stack = SelfHostExecutionStackLayer.pipe(Layer.provide(dbLayer));
const build = makeMcpBuildServer(Layer.merge(stack, pluginsLayer));
const principal = {
  accountId: "bench",
  organizationId: "bench",
  organizationName: "Bench",
  email: "bench@example.test",
  name: "Bench",
  avatarUrl: null,
  roles: ["user"],
  orgRoleModel: "organization" as const,
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashes: Record<string, string> = {};
const checkHash = (name: string, value: unknown) => {
  const hash = digest(value);
  if (hashes[name] !== undefined && hashes[name] !== hash) {
    throw new Error(`Benchmark result changed between samples: ${name}`);
  }
  hashes[name] = hash;
};
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
try {
  const seed = await run(
    makeScopedExecutor<SelfHostPlugins>("bench", "bench", "Bench").pipe(
      Effect.provide(SelfHostScopedExecutorSeams),
      Effect.provide(dbLayer),
    ),
  );
  for (const slug of ["cloudflare_api", "vercel_api"]) {
    const fixture = slug === "cloudflare_api" ? "cloudflare" : "vercel";
    await run(
      seed.openapi.addSpec({
        spec: {
          kind: "blob",
          value: readFileSync(
            resolve(import.meta.dir, `../../../packages/plugins/openapi/fixtures/${fixture}.json`),
            "utf8",
          ),
        },
        slug,
      }),
    );
    await run(
      seed.connections.create({
        owner: "org",
        integration: IntegrationSlug.make(slug),
        name: ConnectionName.make("main"),
        template: AuthTemplateSlug.make("apiKey"),
        value: "fixture-token",
      }),
    );
  }
  const tools = await run(seed.tools.list({ includeAnnotations: false }));
  await run(seed.close());
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const built = await run(
      build(principal, { mode: "passthrough", artifactsEnabled: false }).pipe(
        Effect.withTracer(tracer),
      ),
    );
    record("server.build", performance.now() - start);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fixture-bench", version: "1" }, { capabilities: {} });
    await built.mcpServer.connect(st);
    try {
      let start = performance.now();
      await client.connect(ct);
      record("client.initialize", performance.now() - start);
      start = performance.now();
      const listed = await client.listTools();
      record("client.tools_list", performance.now() - start);
      checkHash("tools", listed);
      checkHash("instructions", client.getInstructions());
      for (const [name, args] of [
        ["filtered", { query: "dns record", integration: "cloudflare_api", limit: 3 }],
        ["full", { query: "dns record", integration: "cloudflare_api", limit: 3, detail: "full" }],
      ] as const) {
        start = performance.now();
        const result = await client.callTool({ name: "search", arguments: args });
        record(`client.search.${name}`, performance.now() - start);
        if (result.isError) throw new Error(JSON.stringify(result));
        checkHash(name, result);
      }
    } finally {
      await client.close();
      await built.mcpServer.close();
      await run(built.engine.shutdown);
      if (built.executor) await run(built.executor.close());
    }
  }
  const summary = Object.fromEntries(
    Object.entries(phases).map(([name, times]) => {
      const sorted = [...times].sort((a, b) => a - b);
      return [
        name,
        {
          n: times.length,
          p50: sorted[Math.ceil(times.length * 0.5) - 1],
          p95: sorted[Math.ceil(times.length * 0.95) - 1],
        },
      ];
    }),
  );
  const result = {
    catalogTools: tools.filter((t) => !t.static).length,
    samples,
    hashes,
    summary,
    phases,
  };
  writeFileSync(
    process.env.BENCH_OUTPUT ?? join(tmpdir(), "executor-mcp-session-bench.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ catalogTools: result.catalogTools, hashes, summary }, null, 2));
} finally {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
}
// The plugin transport pool has process timers. All benchmark-owned handles
// are closed above; finish the standalone measurement process.
process.exit(0);
