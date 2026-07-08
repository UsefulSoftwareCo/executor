/* oxlint-disable executor/no-try-catch-or-throw -- boundary: test temporarily overrides global fetch and restores it in finally */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { IntegrationSlug, ToolResult, createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { FLUSH, pktLine } from "../git-client/pktline";
import { bundleEntry } from "../pipeline/bundle";
import { makeInProcessAppToolExecutor } from "../executor/app-tool-executor";
import type { AppDescriptor } from "../pipeline/descriptor";
import { makeAppsPlugin, projectAppsToolSchema } from "./apps-plugin";
import type { AppSourceRecord, AppsStore } from "./store";

const bundle = (source: string) =>
  bundleEntry({
    files: new Map([["tools/sync.ts", source]]),
    entry: "tools/sync.ts",
  });

const localAppDir = (toolName: string, message: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "executor-apps-test-"));
      await mkdir(join(root, "tools"));
      await writeFile(
        join(root, "tools", `${toolName}.ts`),
        `
          import { z } from "zod";
          import { defineTool } from "executor:app";
          export default defineTool({
            name: "${toolName}",
            description: "${message}",
            input: z.object({}),
            async handler() {
              return { message: "${message}" };
            },
          });
        `,
      );
      return root;
    }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

const collidingPlugin = definePlugin(() => ({
  id: "collider",
  storage: () => ({}),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: IntegrationSlug.make("github"),
        name: "GitHub",
        description: "Existing integration",
        config: {},
      }),
  }),
}))();

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const advertisement = (sha: string): Uint8Array =>
  concat([
    pktLine("# service=git-upload-pack\n"),
    FLUSH,
    pktLine(
      `${sha} HEAD\0symref=HEAD:refs/heads/main multi_ack side-band-64k thin-pack ofs-delta\n`,
    ),
    pktLine(`${sha} refs/heads/main\n`),
    FLUSH,
  ]);

const sideBand = (bytes: Uint8Array): Uint8Array => {
  const payload = new Uint8Array(bytes.length + 1);
  payload[0] = 1;
  payload.set(bytes, 1);
  return concat([pktLine("NAK\n"), pktLine(payload), FLUSH]);
};

const makeSyncStore = (): AppsStore & {
  readonly sources: Map<string, AppSourceRecord>;
  readonly descriptor: (app: string) => AppDescriptor | null;
} => {
  const blobs = new Map<string, string>();
  const sources = new Map<string, AppSourceRecord>();
  const descriptors = new Map<string, { descriptor: AppDescriptor; descriptorKey: string }>();
  return {
    sources,
    descriptor: (app) => descriptors.get(app)?.descriptor ?? null,
    putBlob: (body) =>
      Effect.sync(() => {
        const key = `blob:${blobs.size}`;
        blobs.set(key, body);
        return key;
      }),
    getBlob: (key) => Effect.sync(() => blobs.get(key) ?? null),
    getDescriptorRecord: (app) =>
      Effect.sync(() => {
        const current = descriptors.get(app);
        return current
          ? {
              sourceRef: current.descriptor.sourceRef,
              descriptorKey: current.descriptorKey,
            }
          : null;
      }),
    putPublished: (next, nextDescriptorKey) =>
      Effect.sync(() => {
        descriptors.set(next.app, { descriptor: next, descriptorKey: nextDescriptorKey });
      }),
    removePublished: (app) =>
      Effect.sync(() => {
        descriptors.delete(app);
      }),
    listActiveTools: () =>
      Effect.sync(() =>
        [...descriptors.values()].flatMap(({ descriptor }) =>
          descriptor.tools.map((tool) => ({ ...tool, app: descriptor.app })),
        ),
      ),
    getTool: (name) =>
      Effect.sync(() => {
        const descriptor = [...descriptors.values()].find((entry) =>
          entry.descriptor.tools.some((item) => item.name === name),
        )?.descriptor;
        const tool = descriptor?.tools.find((item) => item.name === name);
        if (!descriptor || !tool) return null;
        return {
          app: descriptor.app,
          name: tool.name,
          bundleKey: tool.bundleKey,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          integrations: tool.integrations,
          annotations: tool.annotations,
        };
      }),
    getToolForApp: (app, name) =>
      Effect.sync(() => {
        const descriptor = descriptors.get(app)?.descriptor;
        const tool = descriptor?.tools.find((item) => item.name === name);
        if (!descriptor || !tool) return null;
        return {
          app: descriptor.app,
          name: tool.name,
          bundleKey: tool.bundleKey,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          integrations: tool.integrations,
          annotations: tool.annotations,
        };
      }),
    putSource: (record) =>
      Effect.sync(() => {
        sources.set(record.slug, record);
      }),
    listSources: () => Effect.sync(() => [...sources.values()]),
    getSource: (slug) => Effect.sync(() => sources.get(slug) ?? null),
    removeSource: (slug) =>
      Effect.sync(() => {
        sources.delete(slug);
      }),
  };
};

const fixtureFetch = async () => {
  const dir = join(import.meta.dirname, "..", "source", "fixtures");
  const [shas, pack1, pack2] = await Promise.all([
    readFile(join(dir, "git-fixture-shas.txt"), "utf8"),
    readFile(join(dir, "git-fixture-v1.pack")),
    readFile(join(dir, "git-fixture-v2.pack")),
  ]);
  const [sha1, sha2] = shas.trim().split("\n");
  let current = { sha: sha1!, pack: new Uint8Array(pack1) };
  let packRequests = 0;
  return {
    fetch: (async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname === "/repo.git/info/refs") {
        return new Response(new Uint8Array(advertisement(current.sha)).buffer, {
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
        });
      }
      if (url.pathname === "/repo.git/git-upload-pack") {
        packRequests += 1;
        return new Response(new Uint8Array(sideBand(current.pack)).buffer, {
          headers: { "content-type": "application/x-git-upload-pack-result" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    advance: () => {
      current = { sha: sha2!, pack: new Uint8Array(pack2) };
    },
    packRequests: () => packRequests,
  };
};

const makeInvokeStore = (input: {
  readonly bundle: string;
  readonly integrations: AppDescriptor["tools"][number]["integrations"];
}): AppsStore => ({
  putBlob: () => Effect.succeed("bundle"),
  getBlob: () => Effect.succeed(input.bundle),
  getDescriptorRecord: () => Effect.succeed(null),
  putPublished: () => Effect.void,
  removePublished: () => Effect.void,
  listActiveTools: () => Effect.succeed([]),
  getTool: () =>
    Effect.succeed({
      app: "crm",
      name: "sync",
      bundleKey: "bundle",
      description: "Sync",
      integrations: input.integrations,
    }),
  getToolForApp: () =>
    Effect.succeed({
      app: "crm",
      name: "sync",
      bundleKey: "bundle",
      description: "Sync",
      integrations: input.integrations,
    }),
  putSource: () => Effect.void,
  listSources: () => Effect.succeed([]),
  getSource: () => Effect.succeed(null),
  removeSource: () => Effect.void,
});

const invokeCtx = (input: {
  readonly bundle: string;
  readonly execute: (address: string, args: unknown) => Effect.Effect<unknown, unknown>;
}) =>
  ({
    storage: makeInvokeStore({
      bundle: input.bundle,
      integrations: { crm: { slug: "dealcloud", mode: "one" } },
    }),
    connections: {
      list: () => Effect.succeed([]),
      get: () =>
        Effect.succeed({
          address: "tools.dealcloud.org.main",
          integration: "dealcloud",
          owner: "org",
          name: "main",
        }),
    },
    execute: (address: string, args: unknown) => input.execute(String(address), args),
  }) as never;

describe("apps plugin schema projection", () => {
  it.effect("narrows synthesized integration fields to connection address enums", () =>
    Effect.gen(function* () {
      const storage: AppsStore = {
        putBlob: () => Effect.succeed("bundle"),
        getBlob: () => Effect.succeed(null),
        getDescriptorRecord: () => Effect.succeed(null),
        putPublished: () => Effect.void,
        removePublished: () => Effect.void,
        listActiveTools: () => Effect.succeed([]),
        putSource: () => Effect.void,
        listSources: () => Effect.succeed([]),
        getSource: () => Effect.succeed(null),
        removeSource: () => Effect.void,
        getTool: () =>
          Effect.succeed({
            app: "crm",
            name: "sync",
            bundleKey: "bundle",
            description: "Sync",
            integrations: {
              crm: { slug: "dealcloud", mode: "one" },
              inboxes: { slug: "gmail", mode: "many" },
            },
          }),
        getToolForApp: () =>
          Effect.succeed({
            app: "crm",
            name: "sync",
            bundleKey: "bundle",
            description: "Sync",
            integrations: {
              crm: { slug: "dealcloud", mode: "one" },
              inboxes: { slug: "gmail", mode: "many" },
            },
          }),
      };
      const result = yield* projectAppsToolSchema(
        {
          storage,
          connections: {
            list: ({ integration }: { readonly integration?: unknown }) =>
              Effect.succeed(
                String(integration) === "dealcloud"
                  ? [{ address: "tools.dealcloud.org.main" }]
                  : [{ address: "tools.gmail.org.work" }, { address: "tools.gmail.user.personal" }],
              ),
          },
        } as never,
        "crm",
        "sync",
        {
          type: "object",
          properties: {
            updatedSince: { type: "string" },
            crm: { type: "string" },
            inboxes: { type: "array", items: { type: "string" } },
          },
          required: ["crm", "inboxes"],
        },
        undefined,
      );
      expect(result.inputSchema).toMatchObject({
        properties: {
          crm: {
            enum: ["tools.dealcloud.org.main"],
            default: "tools.dealcloud.org.main",
          },
          inboxes: {
            default: ["tools.gmail.org.work", "tools.gmail.user.personal"],
            items: {
              enum: ["tools.gmail.org.work", "tools.gmail.user.personal"],
            },
          },
        },
      });
      // The response schema requires JSON values: a `required` key holding
      // undefined fails encoding (the /api/tools/schema 400), so the key must
      // be absent entirely when all required fields were projected away.
      expect("required" in (result.inputSchema as Record<string, unknown>)).toBe(false);
      expect(Object.values(result.inputSchema as Record<string, unknown>).includes(undefined)).toBe(
        false,
      );
    }),
  );
});

describe("apps source sync", () => {
  it.effect("rejects credential-bearing git URLs before storing a source", () =>
    Effect.gen(function* () {
      const store = makeSyncStore();
      const plugin = makeAppsPlugin({ allowPrivateGitHosts: true });
      const extension = plugin.extension!({
        storage: store,
        providers: {
          setDefault: () => Effect.succeed("default"),
          get: () => Effect.succeed(null),
          remove: () => Effect.void,
        },
      } as never);
      const exit = yield* Effect.exit(
        extension.createSource({
          kind: "git",
          slug: "bad",
          app: "bad",
          url: "https://x:secret@example.test/repo",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(store.sources.size).toBe(0);
    }),
  );

  it.effect("redacts query strings from persisted source diagnostics", () =>
    Effect.gen(function* () {
      const store = makeSyncStore();
      store.sources.set("bad", {
        slug: "bad",
        app: "bad",
        kind: "git",
        config: { kind: "git", url: "https://example.test/repo?token=secret" },
        status: { type: "pending" },
        updatedAt: 1,
      });
      const plugin = makeAppsPlugin({
        executor: makeInProcessAppToolExecutor(),
        allowPrivateGitHosts: true,
      });
      const extension = plugin.extension!({
        storage: store,
        providers: {
          setDefault: () => Effect.succeed("default"),
          get: () => Effect.succeed(null),
          remove: () => Effect.void,
        },
      } as never);
      const result = yield* extension.syncSource("bad");
      expect(result.status).toBe("failed");
      const status = store.sources.get("bad")?.status;
      const diagnostic = status?.type === "failed" ? status.errors[0]?.diagnostics?.[0]?.path : "";
      expect(diagnostic).toBe("https://example.test/repo");
    }),
  );

  it.effect("syncs git sources, no-ops unchanged refs, and republishes changed refs", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => fixtureFetch());
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fixture.fetch;
      try {
        const store = makeSyncStore();
        const plugin = makeAppsPlugin({
          executor: makeInProcessAppToolExecutor(),
          allowPrivateGitHosts: true,
        });
        const integrations = new Set<string>();
        const connections = new Set<string>();
        const extension = plugin.extension!({
          storage: store,
          providers: {
            setDefault: () => Effect.succeed("default"),
            get: () => Effect.succeed(null),
            remove: () => Effect.void,
          },
          core: {
            integrations: {
              get: (slug: unknown) =>
                Effect.sync(() =>
                  integrations.has(String(slug))
                    ? ({ slug, kind: "apps", description: "", canRemove: true } as never)
                    : null,
                ),
              register: (input: { readonly slug: unknown }) =>
                Effect.sync(() => {
                  integrations.add(String(input.slug));
                }),
              remove: (slug: unknown) =>
                Effect.sync(() => {
                  integrations.delete(String(slug));
                  connections.delete(String(slug));
                }),
            },
          },
          connections: {
            list: () => Effect.succeed([]),
            resolveValue: () => Effect.succeed(null),
            get: ({ integration }: { readonly integration: unknown }) =>
              Effect.succeed(connections.has(String(integration)) ? ({} as never) : null),
            create: ({ integration }: { readonly integration: unknown }) =>
              Effect.sync(() => {
                connections.add(String(integration));
              }),
            refresh: () => Effect.succeed([]),
          },
        } as never);

        yield* extension.createSource({
          kind: "git",
          slug: "fixture",
          app: "fixture",
          url: "https://example.test/repo",
        });
        const first = yield* extension.syncSource("fixture");
        expect(first.status).toBe("published");
        expect(first.tools).toEqual(["greeter"]);
        expect(fixture.packRequests()).toBe(1);

        const unchanged = yield* extension.syncSource("fixture");
        expect(unchanged.status).toBe("up-to-date");
        expect(fixture.packRequests()).toBe(1);

        fixture.advance();
        const changed = yield* extension.syncSource("fixture");
        expect(changed.status).toBe("published");
        expect(changed.sourceRef).not.toBe(first.sourceRef);
        expect(fixture.packRequests()).toBe(2);
        expect(store.descriptor("fixture")?.sourceRef).toBe(changed.sourceRef);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it.effect("registers each app as its own integration with disjoint tool addresses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const alphaDir = yield* localAppDir("echo", "alpha");
        const betaDir = yield* localAppDir("echo", "beta");
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              memoryCredentialsPlugin(),
              makeAppsPlugin({ sourceKinds: ["local-directory"] }),
            ] as const,
          }),
        );

        yield* executor.apps.createSource({
          kind: "local-directory",
          slug: "alpha-source",
          app: "alpha-tools",
          path: alphaDir,
        });
        yield* executor.apps.createSource({
          kind: "local-directory",
          slug: "beta-source",
          app: "beta-tools",
          path: betaDir,
        });

        const alphaSync = yield* executor.apps.syncSource("alpha-source");
        const betaSync = yield* executor.apps.syncSource("beta-source");
        expect(alphaSync.status).toBe("published");
        expect(betaSync.status).toBe("published");

        const alphaIntegration = yield* executor.integrations.get(
          IntegrationSlug.make("alpha-tools"),
        );
        const betaIntegration = yield* executor.integrations.get(
          IntegrationSlug.make("beta-tools"),
        );
        expect(alphaIntegration?.name).toBe("alpha-tools");
        expect(betaIntegration?.name).toBe("beta-tools");

        const alphaTools = yield* executor.tools.list({
          integration: IntegrationSlug.make("alpha-tools"),
        });
        const betaTools = yield* executor.tools.list({
          integration: IntegrationSlug.make("beta-tools"),
        });
        expect(alphaTools.map((tool) => String(tool.address))).toEqual([
          "tools.alpha-tools.org.published.echo",
        ]);
        expect(betaTools.map((tool) => String(tool.address))).toEqual([
          "tools.beta-tools.org.published.echo",
        ]);
      }),
    ),
  );

  it.effect("rejects an app slug that collides with a non-app integration before publishing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sourceDir = yield* localAppDir("echo", "collision");
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              memoryCredentialsPlugin(),
              collidingPlugin,
              makeAppsPlugin({ sourceKinds: ["local-directory"] }),
            ] as const,
          }),
        );
        yield* executor.collider.seed();
        yield* executor.apps.createSource({
          kind: "local-directory",
          slug: "github-source",
          app: "github",
          path: sourceDir,
        });

        const result = yield* executor.apps.syncSource("github-source");
        expect(result.status).toBe("failed");
        expect(result.errors?.[0]?.message).toContain("github");
        const tools = yield* executor.tools.list({ integration: IntegrationSlug.make("github") });
        expect(tools).toEqual([]);
      }),
    ),
  );

  it.effect("rejects two app sources with the same app slug", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstDir = yield* localAppDir("first", "first");
        const secondDir = yield* localAppDir("second", "second");
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              memoryCredentialsPlugin(),
              makeAppsPlugin({ sourceKinds: ["local-directory"] }),
            ] as const,
          }),
        );
        yield* executor.apps.createSource({
          kind: "local-directory",
          slug: "first-source",
          app: "shared-app",
          path: firstDir,
        });
        yield* executor.apps.createSource({
          kind: "local-directory",
          slug: "second-source",
          app: "shared-app",
          path: secondDir,
        });

        const result = yield* executor.apps.syncSource("first-source");
        expect(result.status).toBe("failed");
        expect(result.errors?.[0]?.message).toContain("shared-app");
        const tools = yield* executor.tools.list({
          integration: IntegrationSlug.make("shared-app"),
        });
        expect(tools).toEqual([]);
      }),
    ),
  );

  it.effect("deleteSource removes the app integration and republish recreates it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sourceDir = yield* localAppDir("echo", "delete");
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              memoryCredentialsPlugin(),
              makeAppsPlugin({ sourceKinds: ["local-directory"] }),
            ] as const,
          }),
        );
        yield* executor.apps.createSource({
          kind: "local-directory",
          slug: "delete-source",
          app: "delete-tools",
          path: sourceDir,
        });
        const firstSync = yield* executor.apps.syncSource("delete-source");
        expect(firstSync.status).toBe("published");
        expect(
          (yield* executor.tools.list({ integration: IntegrationSlug.make("delete-tools") })).map(
            (tool) => String(tool.address),
          ),
        ).toEqual(["tools.delete-tools.org.published.echo"]);

        yield* executor.apps.deleteSource("delete-source");
        expect(yield* executor.integrations.get(IntegrationSlug.make("delete-tools"))).toBe(null);
        expect(
          yield* executor.tools.list({ integration: IntegrationSlug.make("delete-tools") }),
        ).toEqual([]);

        yield* executor.apps.createSource({
          kind: "local-directory",
          slug: "delete-source",
          app: "delete-tools",
          path: sourceDir,
        });
        const secondSync = yield* executor.apps.syncSource("delete-source");
        expect(secondSync.status).toBe("published");
        expect(
          (yield* executor.tools.list({ integration: IntegrationSlug.make("delete-tools") })).map(
            (tool) => String(tool.address),
          ),
        ).toEqual(["tools.delete-tools.org.published.echo"]);
      }),
    ),
  );
});

describe("apps plugin invocation", () => {
  it.effect("surfaces uncaught inner tool failures without binding_error", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Sync",
          integrations: { crm: integration("dealcloud") },
          input: z.object({}),
          async handler(_input, { crm }) {
            await crm.deals.list({});
            return { ok: true };
          },
        });
      `);
      const plugin = makeAppsPlugin({ executor: makeInProcessAppToolExecutor() });
      const result = yield* plugin.invokeTool!({
        ctx: invokeCtx({
          bundle: bundled.code,
          execute: () =>
            Effect.succeed(
              ToolResult.fail({ code: "upstream_failed", message: "CRM unavailable" }),
            ),
        }),
        toolRow: { integration: "crm", name: "sync" },
        args: { crm: "tools.dealcloud.org.main" },
      } as never);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "upstream_failed",
          message: expect.stringContaining("tools.dealcloud.org.main.deals.list"),
        },
      });
      expect(result).toMatchObject({
        error: { message: expect.stringContaining('"CRM unavailable"') },
      });
      expect((result as { readonly error: { readonly code: string } }).error.code).not.toBe(
        "binding_error",
      );
    }),
  );

  it.effect("lets handlers catch inner tool failures and return a fallback", () =>
    Effect.gen(function* () {
      const bundled = yield* bundle(`
        import { z } from "zod";
        import { defineTool, integration } from "executor:app";
        export default defineTool({
          description: "Sync",
          integrations: { crm: integration("dealcloud") },
          input: z.object({}),
          async handler(_input, { crm }) {
            try {
              await crm.deals.list({});
              return { fallback: false };
            } catch {
              return { fallback: true };
            }
          },
        });
      `);
      const plugin = makeAppsPlugin({ executor: makeInProcessAppToolExecutor() });
      const result = yield* plugin.invokeTool!({
        ctx: invokeCtx({
          bundle: bundled.code,
          execute: () =>
            Effect.succeed(
              ToolResult.fail({ code: "upstream_failed", message: "CRM unavailable" }),
            ),
        }),
        toolRow: { integration: "crm", name: "sync" },
        args: { crm: "tools.dealcloud.org.main" },
      } as never);
      expect(result).toEqual({ fallback: true });
    }),
  );
});
