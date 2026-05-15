import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Scope, ScopeId, createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";

const ORG_ID = "org-acme";
const USER_A = "user-alice";
const USER_B = "user-bob";

const orgScopeId = ScopeId.make(ORG_ID);
const aInnerId = ScopeId.make(`user-org:${USER_A}:${ORG_ID}`);
const bInnerId = ScopeId.make(`user-org:${USER_B}:${ORG_ID}`);

const makeScope = (id: ScopeId, name: string): Scope =>
  Scope.make({ id, name, createdAt: new Date() });

const makeSharedOrgExecutors = () =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const plugins = [mcpPlugin()] as const;
      const config = makeTestConfig({ plugins });
      const orgScope = makeScope(orgScopeId, "Acme");

      const makeFor = (innerId: ScopeId) =>
        createExecutor({
          ...config,
          scopes: [makeScope(innerId, "Personal"), orgScope],
        });

      const execA = yield* makeFor(aInnerId);
      const execB = yield* makeFor(bInnerId);

      return { execA, execB, testDb: config.testDb };
    }),
    ({ execA, execB, testDb }) =>
      Effect.all([execA.close(), execB.close(), Effect.promise(() => testDb.close())], {
        discard: true,
      }).pipe(Effect.ignore),
  );

const seedSource = (
  addSource: (c: {
    readonly transport: "remote";
    readonly scope: string;
    readonly name: string;
    readonly endpoint: string;
    readonly remoteTransport: "auto";
    readonly namespace: string;
  }) => Effect.Effect<unknown, unknown>,
  args: {
    readonly scope: string;
    readonly name: string;
    readonly namespace: string;
  },
) =>
  addSource({
    transport: "remote",
    scope: args.scope,
    name: args.name,
    endpoint: `http://127.0.0.1:1/${args.namespace}`,
    remoteTransport: "auto",
    namespace: args.namespace,
  }).pipe(Effect.result);

describe("MCP cross-user isolation within the same org", () => {
  it.effect("user B does not see user A's inner-scope MCP source", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedOrgExecutors();

      yield* seedSource(execA.mcp.addSource, {
        scope: aInnerId,
        name: "Alice Personal",
        namespace: "alice_personal",
      });

      const bSources = yield* execB.sources.list();
      expect(bSources.map((source) => source.id)).not.toContain("alice_personal");
    }),
  );

  it.effect("user B sees org-scope MCP sources", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedOrgExecutors();

      yield* seedSource(execA.mcp.addSource, {
        scope: orgScopeId,
        name: "Org Shared",
        namespace: "org_shared",
      });

      const bSources = yield* execB.sources.list();
      expect(bSources.map((source) => source.id)).toContain("org_shared");
    }),
  );

  it.effect("each user sees their own inner source and shared org sources only", () =>
    Effect.gen(function* () {
      const { execA, execB } = yield* makeSharedOrgExecutors();

      yield* seedSource(execA.mcp.addSource, {
        scope: aInnerId,
        name: "Alice Personal",
        namespace: "alice_personal",
      });
      yield* seedSource(execB.mcp.addSource, {
        scope: bInnerId,
        name: "Bob Personal",
        namespace: "bob_personal",
      });
      yield* seedSource(execA.mcp.addSource, {
        scope: orgScopeId,
        name: "Org Shared",
        namespace: "org_shared",
      });

      const aIds = (yield* execA.sources.list()).map((source) => source.id);
      const bIds = (yield* execB.sources.list()).map((source) => source.id);

      expect(aIds).toContain("alice_personal");
      expect(aIds).toContain("org_shared");
      expect(aIds).not.toContain("bob_personal");

      expect(bIds).toContain("bob_personal");
      expect(bIds).toContain("org_shared");
      expect(bIds).not.toContain("alice_personal");
    }),
  );
});
