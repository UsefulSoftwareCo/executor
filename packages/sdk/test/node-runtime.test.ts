/** Optional framework peers resolve from each retained app installation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { HostToolNotFound, HostOperationNotFound } from "apps/contracts";
import { SourceFiles } from "../src/contracts/deployment.ts";
import { nodeRuntime } from "@executor-js/sdk/node";
import { toEffectRuntime, RuntimeBuildFailed } from "@executor-js/sdk/core";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import * as Tar from "tar";

const appSource = (
  imports: string,
  description: string,
  result = '"ok"',
) => `import { defineApp, object, mutation } from "apps";
${imports};
export default defineApp({ accounts: {} }, async () => ({
    mutations: { info: mutation({ description: ${description}, input: object({}) }, async () => ${result}) },
}));
`;
const files = (content: string, dependencies?: Readonly<Record<string, string>>) =>
  Schema.decodeUnknownSync(SourceFiles)([
    { path: "index.ts", content },
    ...(dependencies === undefined
      ? []
      : [{ path: "package.json", content: JSON.stringify({ dependencies }) }]),
  ]);

test("the Node SDK retains the app's selected npm framework and UI", { timeout: 60_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const fixture = path.join(directory, "package");
        yield* fs.copy(
          yield* path.fromFileUrl(new URL("../../apps/dist", import.meta.url)),
          fixture,
        );
        const entry = path.join(fixture, "js/index.js");
        yield* fs.writeFileString(
          entry,
          (yield* fs.readFileString(entry)) +
            '\nexport const packageFixture = "older-node-package";\n',
        );
        const archive = path.join(directory, "apps.tgz");
        yield* Effect.tryPromise(() =>
          Tar.create({ cwd: directory, file: archive, gzip: true }, ["package"]),
        );
        const work = path.join(directory, "work");
        const blobs = memoryBlobStore();
        const runtime = toEffectRuntime(nodeRuntime({ workDirectory: work }), blobs);
        const built = yield* runtime.build({
          files: Schema.decodeUnknownSync(SourceFiles)([
            ...files(
              appSource(
                'import { packageFixture } from "apps"',
                '"Selected package"',
                "packageFixture",
              ),
              { apps: `file:${archive}` },
            ),
            {
              path: "ui/index.html",
              content:
                '<html><head><script type="module" src="./main.ts"></script></head><body></body></html>',
            },
            {
              path: "ui/main.ts",
              content:
                'import { packageFixture } from "apps"; document.body.textContent = packageFixture;',
            },
          ]),
        });
        yield* fs.remove(work, { recursive: true });
        yield* fs.remove(archive);
        yield* fs.remove(fixture, { recursive: true });
        const restored = toEffectRuntime(
          nodeRuntime({ workDirectory: path.join(directory, "restored") }),
          blobs,
        );
        assert.equal(
          yield* restored.call({
            app: "package-fixture",
            build: built.build,
            accounts: Redacted.make({}),
            tool: "mutations.info",
            input: {},
          }),
          "older-node-package",
        );
        const script = built.ui?.find((file) => file.path.endsWith(".js"));
        assert.ok(script);
        assert.ok(restored.asset);
        const asset = yield* restored.asset({ build: built.build, path: script.path });
        assert.match(new TextDecoder().decode(asset?.body), /older-node-package/);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ),
);

test("a retained Node app discovers and calls a real stdio MCP process", { timeout: 30_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const server = path.join(directory, "mcp-server.mjs");
        yield* fs.writeFileString(
          server,
          `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
const server = new Server({ name: "node-runtime-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
  name: "echo", description: "Return synthetic input", annotations: { readOnlyHint: true },
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}] }));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => ({
  content: [{ type: "text", text: JSON.stringify(params.arguments) }],
}));
await server.connect(new StdioServerTransport());
`,
        );
        const work = path.join(directory, "work");
        const blobs = memoryBlobStore();
        const runtime = toEffectRuntime(nodeRuntime({ workDirectory: work }), blobs);
        const built = yield* runtime.build({
          files: files(
            `
import { defineApp } from "apps";
import { stdioOperations } from "apps/mcp/stdio";
export default defineApp({ accounts: {} }, async () => ({
  ...await stdioOperations({ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(server)}], env: {}, timeoutMs: 5000 }),
}));
`,
            { "@modelcontextprotocol/sdk": "1.30.0" },
          ),
        });
        assert.equal(yield* fs.exists(path.join(work, built.build, "bun.lock")), true);
        assert.equal(
          yield* fs.exists(path.join(work, built.build, "node_modules/.bun-cache")),
          false,
        );
        yield* fs.remove(work, { recursive: true });
        const restored = toEffectRuntime(
          nodeRuntime({ workDirectory: path.join(directory, "restored") }),
          blobs,
        );
        const context = { app: "stdio-fixture", build: built.build, accounts: Redacted.make({}) };
        assert.deepEqual(
          (yield* restored.inspect(context)).map((tool) => tool.name),
          ["queries.echo"],
        );
        const result = yield* restored.call({
          ...context,
          tool: "queries.echo",
          input: { text: "node adapter" },
        });
        const parsed = Schema.decodeUnknownSync(
          Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
        )(result);
        assert.equal(parsed.content[0]?.text, JSON.stringify({ text: "node adapter" }));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ),
);

test(
  "dependency scripts stay disabled and package data survives restoration",
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const fixture = path.join(directory, "package");
          yield* fs.makeDirectory(fixture);
          yield* fs.writeFileString(
            path.join(fixture, "package.json"),
            JSON.stringify({
              name: "retained-data-fixture",
              version: "1.0.0",
              type: "module",
              main: "index.js",
              scripts: {
                postinstall: "node -e \"require('node:fs').writeFileSync('script-ran', 'yes')\"",
              },
            }),
          );
          yield* fs.writeFileString(
            path.join(fixture, "index.js"),
            `import { existsSync, readFileSync } from "node:fs";
export const result = {
  data: readFileSync(new URL("./payload.d.ts", import.meta.url), "utf8"),
  wasm: new WebAssembly.Module(readFileSync(new URL("./empty.wasm", import.meta.url))) instanceof WebAssembly.Module,
  scriptRan: existsSync(new URL("./script-ran", import.meta.url)),
};`,
          );
          yield* fs.writeFileString(path.join(fixture, "payload.d.ts"), "runtime data");
          yield* fs.writeFile(
            path.join(fixture, "empty.wasm"),
            new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
          );
          const archive = path.join(directory, "fixture.tgz");
          yield* Effect.tryPromise(() =>
            Tar.create({ cwd: directory, file: archive, gzip: true }, ["package"]),
          );
          const work = path.join(directory, "work");
          const blobs = memoryBlobStore();
          const runtime = toEffectRuntime(nodeRuntime({ workDirectory: work }), blobs);
          const built = yield* runtime.build({
            files: files(
              appSource(
                'import { result } from "retained-data-fixture"',
                '"Package data"',
                "result",
              ),
              { "retained-data-fixture": `file:${archive}` },
            ),
          });
          yield* fs.remove(work, { recursive: true });
          const restored = toEffectRuntime(
            nodeRuntime({ workDirectory: path.join(directory, "restored") }),
            blobs,
          );
          assert.deepEqual(
            yield* restored.call({
              app: "data-fixture",
              build: built.build,
              accounts: Redacted.make({}),
              tool: "mutations.info",
              input: {},
            }),
            {
              data: "runtime data",
              wasm: true,
              scriptRan: false,
            },
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
);

test(
  "Node builds honor locks, reject stale locks and keep dependency files independent",
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const blobs = memoryBlobStore();
          const runtime = toEffectRuntime(nodeRuntime({ workDirectory: directory }), blobs);
          const content = appSource(
            'import { version } from "graphql"',
            '"Pinned version"',
            "version",
          );
          const declared = files(content, { graphql: "^16.10.0" });
          const npmLock = {
            path: "package-lock.json",
            content: JSON.stringify({
              lockfileVersion: 3,
              packages: {
                "": { dependencies: { graphql: "^16.10.0" } },
                "node_modules/graphql": {
                  version: "16.10.0",
                  resolved: "https://registry.npmjs.org/graphql/-/graphql-16.10.0.tgz",
                  integrity:
                    "sha512-AjqGKbDGUFRKIRCP9tCKiIGHyriz2oHEbPIbEtcSLSs4YjReZOIPQQWek4+6hjw62H9QShXHyaGivGiYVLeYFQ==",
                },
              },
            }),
          };
          const first = yield* runtime.build({
            files: Schema.decodeUnknownSync(SourceFiles)([...declared, npmLock]),
          });
          const bunLock = {
            path: "bun.lock",
            content: yield* fs.readFileString(path.join(directory, first.build, "bun.lock")),
          };
          const second = yield* runtime.build({
            files: Schema.decodeUnknownSync(SourceFiles)([...declared, bunLock]),
          });
          for (const built of [first, second]) {
            const stats = yield* fs.stat(
              path.join(directory, built.build, "node_modules/graphql/version.js"),
            );
            assert.equal(
              Option.getOrThrow(stats.nlink),
              1,
              "app files must not share writable cache inodes",
            );
            yield* fs.remove(path.join(directory, built.build), { recursive: true });
            const restored = toEffectRuntime(
              nodeRuntime({ workDirectory: path.join(directory, "restored") }),
              blobs,
            );
            assert.equal(
              yield* restored.call({
                app: "lock-fixture",
                build: built.build,
                accounts: Redacted.make({}),
                tool: "mutations.info",
                input: {},
              }),
              "16.10.0",
            );
          }
          for (const lock of [npmLock, bunLock]) {
            for (const dependencies of [{ graphql: "15.8.0" }, {}]) {
              const rejected = yield* runtime
                .build({
                  files: Schema.decodeUnknownSync(SourceFiles)([
                    ...files(content, dependencies),
                    lock,
                  ]),
                })
                .pipe(Effect.flip);
              assert.ok(Schema.is(RuntimeBuildFailed)(rejected));
              assert.equal(rejected.stage, "dependencies");
            }
          }
          const aliased = yield* runtime
            .build({
              files: files(appSource("", '"Fixture"'), { "framework-copy": "npm:effect@3.0.0" }),
            })
            .pipe(Effect.flip);
          assert.ok(Schema.is(RuntimeBuildFailed)(aliased));
          assert.equal(aliased.stage, "dependencies");
          assert.deepEqual((yield* fs.readDirectory(directory)).sort(), [
            ".dependencies",
            "restored",
          ]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
);

for (const fixture of [
  { name: "root", imports: "", description: '"Root"', dependencies: {} },
  {
    name: "HTTP MCP",
    imports: 'import { mcpOperations } from "apps/mcp"',
    description: "typeof mcpOperations",
    dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
  },
  {
    name: "stdio MCP",
    imports: 'import { stdioOperations } from "apps/mcp/stdio"',
    description: "typeof stdioOperations",
    dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
  },
]) {
  test(
    `${fixture.name} builds and runs with only its declared dependencies`,
    { timeout: 30_000 },
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const directory = yield* fs.makeTempDirectoryScoped();
            const runtime = toEffectRuntime(
              nodeRuntime({ workDirectory: directory }),
              memoryBlobStore(),
            );
            const built = yield* runtime.build({
              files: files(appSource(fixture.imports, fixture.description), fixture.dependencies),
            });
            const code = yield* fs.readFileString(path.join(directory, built.build, "app.mjs"));
            assert.equal(
              yield* fs.exists(path.join(directory, built.build, "node_modules/.bun-cache")),
              false,
              "package caches must not be retained inside each app",
            );
            assert.doesNotMatch(code, /graphql/);
            if (fixture.name !== "stdio MCP")
              assert.doesNotMatch(code, /StdioClientTransport|client\/stdio/);
            if (fixture.name === "root") assert.doesNotMatch(code, /@modelcontextprotocol/);
            const result = yield* runtime.call({
              app: "synthetic-app",
              build: built.build,
              accounts: Redacted.make({}),
              tool: "mutations.info",
              input: {},
            });
            assert.equal(result, "ok");
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
  );
}

test("missing optional peers fail during build instead of using host dependencies", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const runtime = toEffectRuntime(
          nodeRuntime({ workDirectory: directory }),
          memoryBlobStore(),
        );
        for (const fixture of [
          { subpath: "mcp", helper: "mcpOperations", dependency: "@modelcontextprotocol/sdk" },
          {
            subpath: "mcp/stdio",
            helper: "stdioOperations",
            dependency: "@modelcontextprotocol/sdk",
          },
          { subpath: "graphql", helper: "graphqlOperations", dependency: "graphql" },
        ]) {
          const error = yield* Effect.flip(
            runtime.build({
              files: files(
                appSource(
                  `import { ${fixture.helper} } from "apps/${fixture.subpath}"`,
                  `typeof ${fixture.helper}`,
                ),
              ),
            }),
          );
          assert.equal(error._tag, "RuntimeBuildFailed");
          if (error._tag !== "RuntimeBuildFailed") throw new Error("Expected build failure");
          assert.equal(error.stage, "dependencies");
          assert.equal(error.dependency, fixture.dependency);
          assert.deepEqual(yield* fs.readDirectory(directory), []);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test(
  "a helper and app resolve the declared peer version from retained dependencies",
  { timeout: 30_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const runtime = toEffectRuntime(
            nodeRuntime({ workDirectory: directory }),
            memoryBlobStore(),
          );
          const built = yield* runtime.build({
            files: files(
              appSource(
                'import { graphqlOperations } from "apps/graphql"\nimport { version } from "graphql"',
                "typeof graphqlOperations",
                "version",
              ),
              { graphql: "16.10.0" },
            ),
          });
          const code = yield* fs.readFileString(path.join(directory, built.build, "app.mjs"));
          assert.match(code, /from "graphql"/);
          assert.doesNotMatch(code, /node_modules[^\n]*graphql/);
          const result = yield* runtime.call({
            app: "synthetic-app",
            build: built.build,
            accounts: Redacted.make({}),
            tool: "mutations.info",
            input: {},
          });
          assert.equal(result, "16.10.0");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);

test(
  "browser builds reject executable server imports and serve only manifest assets",
  { timeout: 30_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const runtime = toEffectRuntime(
            nodeRuntime({ workDirectory: directory }),
            memoryBlobStore(),
          );
          const source = [
            { path: "index.ts", content: appSource("", '"Server-only implementation"') },
            {
              path: "ui/index.html",
              content:
                '<html><head><script type="module" src="./main.ts"></script></head><body></body></html>',
            },
            { path: "ui/main.ts", content: 'import app from "../index.ts"; console.log(app)' },
            {
              path: "ui/style.css",
              content: '@import "tailwindcss"; .plain { color: rebeccapurple; }',
            },
          ];
          const rejected = yield* Effect.flip(
            runtime.build({ files: Schema.decodeUnknownSync(SourceFiles)(source) }),
          );
          assert.equal(rejected._tag, "RuntimeBuildFailed");
          const built = yield* runtime.build({
            files: Schema.decodeUnknownSync(SourceFiles)(
              source.map((file) =>
                file.path === "ui/main.ts"
                  ? {
                      ...file,
                      content:
                        'import "./style.css"; document.body.className = "p-[13px]"; document.body.textContent = "App UI"',
                    }
                  : file,
              ),
            ),
          });
          assert.ok(built.ui?.some((asset) => asset.path.endsWith(".js")));
          const asset = runtime.asset;
          assert.ok(asset);
          assert.equal(yield* asset({ build: built.build, path: "../source/index.ts" }), undefined);
          assert.equal(yield* asset({ build: built.build, path: "index.ts" }), undefined);
          const html = yield* asset({ build: built.build, path: "index.html" });
          assert.equal(html?.contentType, "text/html");
          const stylesheet = built.ui?.find((file) => file.contentType === "text/css");
          assert.ok(stylesheet);
          const css = yield* asset({ build: built.build, path: stylesheet.path });
          assert.ok(css);
          assert.match(new TextDecoder().decode(css.body), /padding:\s*13px/);
          assert.match(new TextDecoder().decode(css.body), /rebeccapurple/);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);

test("runtime operations preserve their own lookup failures", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const runtime = toEffectRuntime(
          nodeRuntime({ workDirectory: directory }),
          memoryBlobStore(),
        );
        const built = yield* runtime.build({ files: files(appSource("", '"Fixture"')) });
        const context = { build: built.build, accounts: Redacted.make({}) };
        assert.equal((yield* runtime.inspect({ ...context, app: "synthetic-app" })).length, 1);
        const missingTool = yield* runtime
          .call({ app: "synthetic-app", ...context, tool: "mutations.missing", input: {} })
          .pipe(Effect.flip);
        const missingQuery = yield* runtime
          .query({ ...context, app: "test-app", name: "missing", input: {} })
          .pipe(Effect.flip);
        assert.ok(Schema.is(HostToolNotFound)(missingTool));
        assert.ok(Schema.is(HostOperationNotFound)(missingQuery));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
