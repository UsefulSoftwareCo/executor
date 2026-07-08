/* oxlint-disable executor/no-try-catch-or-throw -- boundary: test temporarily overrides global fetch and restores it in finally */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ToolResult } from "@executor-js/sdk";

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
  readonly descriptor: () => AppDescriptor | null;
} => {
  const blobs = new Map<string, string>();
  const sources = new Map<string, AppSourceRecord>();
  let descriptor: AppDescriptor | null = null;
  let descriptorKey: string | null = null;
  return {
    sources,
    descriptor: () => descriptor,
    putBlob: (body) =>
      Effect.sync(() => {
        const key = `blob:${blobs.size}`;
        blobs.set(key, body);
        return key;
      }),
    getBlob: (key) => Effect.sync(() => blobs.get(key) ?? null),
    getDescriptorRecord: () =>
      Effect.sync(() =>
        descriptor ? { sourceRef: descriptor.sourceRef, descriptorKey: descriptorKey ?? "" } : null,
      ),
    putPublished: (next, nextDescriptorKey) =>
      Effect.sync(() => {
        descriptor = next;
        descriptorKey = nextDescriptorKey;
      }),
    listActiveTools: () => Effect.sync(() => descriptor?.tools ?? []),
    getTool: (name) =>
      Effect.sync(() => {
        const tool = descriptor?.tools.find((item) => item.name === name);
        return tool
          ? {
              app: descriptor!.app,
              name: tool.name,
              bundleKey: tool.bundleKey,
              description: tool.description,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              integrations: tool.integrations,
              annotations: tool.annotations,
            }
          : null;
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
  listActiveTools: () => Effect.succeed([]),
  getTool: () =>
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
          crm: { enum: ["tools.dealcloud.org.main"] },
          inboxes: {
            items: {
              enum: ["tools.gmail.org.work", "tools.gmail.user.personal"],
            },
          },
        },
        required: ["crm", "inboxes"],
      });
    }),
  );
});

describe("apps source sync", () => {
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
        let connectionExists = false;
        const extension = plugin.extension!({
          storage: store,
          providers: {
            setDefault: () => Effect.succeed("default"),
            get: () => Effect.succeed(null),
            remove: () => Effect.void,
          },
          core: {
            integrations: {
              register: () => Effect.void,
            },
          },
          connections: {
            list: () => Effect.succeed([]),
            resolveValue: () => Effect.succeed(null),
            get: () => Effect.succeed(connectionExists ? ({} as never) : null),
            create: () =>
              Effect.sync(() => {
                connectionExists = true;
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
        expect(store.descriptor()?.sourceRef).toBe(changed.sourceRef);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
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
        toolRow: { name: "sync" },
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
        toolRow: { name: "sync" },
        args: { crm: "tools.dealcloud.org.main" },
      } as never);
      expect(result).toEqual({ fallback: true });
    }),
  );
});
