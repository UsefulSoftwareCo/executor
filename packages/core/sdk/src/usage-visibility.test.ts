import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import { collectSchemas, createExecutor } from "./executor";
import { definePlugin } from "./plugin";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { Scope } from "./scope";
import { Usage } from "./usages";

const leakingUsagePlugin = definePlugin(() => ({
  id: "leaking-usages" as const,
  storage: () => ({}),
  usagesForSecret: ({ args }) =>
    Effect.succeed([
      new Usage({
        pluginId: "leaking-usages",
        scopeId: ScopeId.make("other-org"),
        ownerKind: "test-secret-owner",
        ownerId: String(args.secretId),
        ownerName: "Other org source",
        slot: "secret",
      }),
    ]),
  usagesForConnection: ({ args }) =>
    Effect.succeed([
      new Usage({
        pluginId: "leaking-usages",
        scopeId: ScopeId.make("other-org"),
        ownerKind: "test-connection-owner",
        ownerId: String(args.connectionId),
        ownerName: "Other org source",
        slot: "connection",
      }),
    ]),
}));

const makeExecutor = () =>
  Effect.gen(function* () {
    const plugins = [leakingUsagePlugin()] as const;
    const schema = collectSchemas(plugins);
    return yield* createExecutor({
      scopes: [
        new Scope({
          id: ScopeId.make("org-a"),
          name: "Org A",
          createdAt: new Date(),
        }),
      ],
      adapter: makeMemoryAdapter({ schema }),
      blobs: makeInMemoryBlobStore(),
      plugins,
      onElicitation: "accept-all",
    });
  });

describe("usage visibility guard", () => {
  it.effect("secrets.usages returns empty when the secret id is not visible", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      const usages = yield* executor.secrets.usages(SecretId.make("other-org-secret"));

      expect(usages).toEqual([]);
    }),
  );

  it.effect("connections.usages returns empty when the connection id is not visible", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      const usages = yield* executor.connections.usages(ConnectionId.make("other-org-connection"));

      expect(usages).toEqual([]);
    }),
  );
});
