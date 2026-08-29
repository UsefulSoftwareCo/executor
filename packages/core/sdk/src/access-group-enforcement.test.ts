import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { createExecutor } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig, makeTestWorkspaceHarness } from "./testing";

// ---------------------------------------------------------------------------
// Access-group ENFORCEMENT invariants — the red-team suite. A restricted org
// connection must behave, for a non-member, exactly like a nonexistent one on
// EVERY read and invoke surface: no listing (even with includeBlocked), no
// schema, no connection read/update/remove, no invoke, no distinguishable
// error, and no policy that re-exposes it. Membership is read live per call.
// The unrestricted views (platform view, subject-less org binding) stay
// deliberately unfiltered.
// ---------------------------------------------------------------------------

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const VERCEL = IntegrationSlug.make("vercel");
const GITHUB = IntegrationSlug.make("github");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const enforcementTestPlugin = definePlugin(() => ({
  id: "etest" as const,
  storage: () => ({}),
  credentialProviders: [memoryProvider()],
  resolveTools: ({ integration }) =>
    Effect.succeed({
      tools:
        String(integration.slug) === "vercel"
          ? [
              { name: ToolName.make("deploy"), description: "deploy" },
              { name: ToolName.make("logs"), description: "read logs" },
            ]
          : [{ name: ToolName.make("list"), description: "list repos" }],
    }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: `${toolRow.integration}.${toolRow.name}` }),
  extension: (ctx) => ({
    seed: () =>
      Effect.gen(function* () {
        yield* ctx.core.integrations.register({ slug: VERCEL, description: "Vercel", config: {} });
        yield* ctx.core.integrations.register({ slug: GITHUB, description: "GitHub", config: {} });
      }),
  }),
}));

const plugins = [enforcementTestPlugin()] as const;

const MEMBER = "member-subject";
const NON_MEMBER = "non-member-subject";

const addr = (integration: IntegrationSlug, tool: string): ToolAddress =>
  ToolAddress.make(`tools.${integration}.org.${CONN}.${tool}`);

/**
 * Shared-tenant fixture: an admin binding seeds two org connections (vercel +
 * github), creates the "finance" group with MEMBER in it, and restricts the
 * vercel connection to it. Returns the two subject-bound executors plus the
 * admin harness (which manages the group but is NOT a member — its runtime
 * view is filtered like everyone's).
 */
const setupRestrictedWorkspace = Effect.gen(function* () {
  const dataDir = mkdtempSync(join(tmpdir(), "access-groups-"));
  const tenant = "shared-tenant";

  const admin = yield* makeTestWorkspaceHarness({ plugins, tenant, subject: "admin", dataDir });
  yield* admin.executor.etest.seed();
  for (const integration of [VERCEL, GITHUB]) {
    yield* admin.executor.connections.create({
      owner: "org",
      name: CONN,
      integration,
      template: TEMPLATE,
      from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("k") },
    });
  }
  const group = yield* admin.executor.accessGroups.create({ name: "finance" });
  yield* admin.executor.accessGroups.addMember({ id: group.id, subject: MEMBER });
  yield* admin.executor.accessGroups.restrictConnection({
    integration: VERCEL,
    name: CONN,
    group: group.id,
  });

  const member = yield* makeTestWorkspaceHarness({ plugins, tenant, subject: MEMBER, dataDir });
  const nonMember = yield* makeTestWorkspaceHarness({
    plugins,
    tenant,
    subject: NON_MEMBER,
    dataDir,
  });
  return { admin, member, nonMember, group, tenant, dataDir };
});

describe("access-group enforcement", () => {
  it.effect("hides restricted tools from non-members on tools.list, even includeBlocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { member, nonMember } = yield* setupRestrictedWorkspace;

        const memberTools = yield* member.executor.tools.list();
        expect(
          memberTools
            .filter((tool) => tool.integration === VERCEL)
            .map((tool) => String(tool.name)),
        ).toEqual(["deploy", "logs"]);

        for (const filter of [undefined, { includeBlocked: true }] as const) {
          const tools = yield* nonMember.executor.tools.list(filter);
          expect(tools.filter((tool) => tool.integration === VERCEL)).toEqual([]);
          // The unrestricted github connection is completely unaffected.
          expect(
            tools.filter((tool) => tool.integration === GITHUB).map((tool) => String(tool.name)),
          ).toEqual(["list"]);
        }
      }),
    ),
  );

  it.effect("hides the restricted connection and its schema from non-members", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { member, nonMember } = yield* setupRestrictedWorkspace;

        const memberConnections = yield* member.executor.connections.list();
        expect(
          memberConnections.map((connection) => String(connection.integration)).sort(),
        ).toEqual(["github", "vercel"]);

        const nonMemberConnections = yield* nonMember.executor.connections.list();
        expect(nonMemberConnections.map((connection) => String(connection.integration))).toEqual([
          "github",
        ]);

        const ref = { owner: "org", integration: VERCEL, name: CONN } as const;
        expect(yield* member.executor.connections.get(ref)).not.toBeNull();
        expect(yield* nonMember.executor.connections.get(ref)).toBeNull();

        expect(yield* member.executor.tools.schema(addr(VERCEL, "deploy"))).not.toBeNull();
        expect(yield* nonMember.executor.tools.schema(addr(VERCEL, "deploy"))).toBeNull();
      }),
    ),
  );

  it.effect("refuses non-member update/remove with the nonexistent-connection error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { member, nonMember } = yield* setupRestrictedWorkspace;
        const ref = { owner: "org", integration: VERCEL, name: CONN } as const;

        const updateError = yield* Effect.flip(
          nonMember.executor.connections.update(ref, { description: "mine now" }),
        );
        expect(Predicate.isTagged("ConnectionNotFoundError")(updateError)).toBe(true);

        const removeError = yield* Effect.flip(nonMember.executor.connections.remove(ref));
        expect(Predicate.isTagged("ConnectionNotFoundError")(removeError)).toBe(true);
        // Nothing was deleted: the member still sees it.
        expect(yield* member.executor.connections.get(ref)).not.toBeNull();
      }),
    ),
  );

  it.effect("invoke fails for non-members exactly like a nonexistent connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { member, nonMember } = yield* setupRestrictedWorkspace;

        expect(yield* member.executor.execute(addr(VERCEL, "deploy"), {})).toEqual({
          ran: "vercel.deploy",
        });

        const hidden = yield* Effect.flip(nonMember.executor.execute(addr(VERCEL, "deploy"), {}));
        // A connection that genuinely does not exist — the shape the hidden
        // answer must be indistinguishable from (no oracle).
        const nonexistent = yield* Effect.flip(
          nonMember.executor.execute(
            ToolAddress.make(`tools.vercel.org.no-such-connection.deploy`),
            {},
          ),
        );
        expect(Predicate.isTagged("ToolNotFoundError")(hidden)).toBe(true);
        expect(Predicate.isTagged("ToolNotFoundError")(nonexistent)).toBe(true);
        const suggestionsOf = (error: unknown) =>
          (error as { readonly suggestions?: readonly unknown[] }).suggestions ?? [];
        expect(suggestionsOf(hidden)).toEqual(suggestionsOf(nonexistent));
        expect(suggestionsOf(hidden)).toEqual([]);

        // A wrong tool name on the hidden connection must not leak the
        // connection's real tools through suggestions either.
        const wrongTool = yield* Effect.flip(nonMember.executor.execute(addr(VERCEL, "nope"), {}));
        expect(Predicate.isTagged("ToolNotFoundError")(wrongTool)).toBe(true);
        expect(suggestionsOf(wrongTool)).toEqual([]);
      }),
    ),
  );

  it.effect("an org policy approve does not re-expose a restricted tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { nonMember } = yield* setupRestrictedWorkspace;

        yield* nonMember.executor.policies.create({
          owner: "org",
          pattern: "vercel.*",
          action: "approve",
        });

        const tools = yield* nonMember.executor.tools.list({ includeBlocked: true });
        expect(tools.filter((tool) => tool.integration === VERCEL)).toEqual([]);
        const error = yield* Effect.flip(nonMember.executor.execute(addr(VERCEL, "deploy"), {}));
        expect(Predicate.isTagged("ToolNotFoundError")(error)).toBe(true);
      }),
    ),
  );

  it.effect("membership is read live: roster edits apply to an already-open executor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { admin, nonMember, group } = yield* setupRestrictedWorkspace;

        expect(
          (yield* nonMember.executor.tools.list()).filter((tool) => tool.integration === VERCEL),
        ).toEqual([]);

        // Grant mid-"session" — the SAME bound executor sees it next call.
        yield* admin.executor.accessGroups.addMember({ id: group.id, subject: NON_MEMBER });
        expect(
          (yield* nonMember.executor.tools.list())
            .filter((tool) => tool.integration === VERCEL)
            .map((tool) => String(tool.name)),
        ).toEqual(["deploy", "logs"]);
        expect(yield* nonMember.executor.execute(addr(VERCEL, "deploy"), {})).toEqual({
          ran: "vercel.deploy",
        });

        // Revoke — blocked again on the very next call, no rebuild.
        yield* admin.executor.accessGroups.removeMember({ id: group.id, subject: NON_MEMBER });
        expect(
          (yield* nonMember.executor.tools.list()).filter((tool) => tool.integration === VERCEL),
        ).toEqual([]);
        const error = yield* Effect.flip(nonMember.executor.execute(addr(VERCEL, "deploy"), {}));
        expect(Predicate.isTagged("ToolNotFoundError")(error)).toBe(true);
      }),
    ),
  );

  it.effect("the admin's runtime view is filtered like everyone's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { admin } = yield* setupRestrictedWorkspace;
        // The admin manages the group but is not a member: the management
        // surface still reports the restriction...
        expect(yield* admin.executor.accessGroups.restrictions()).toHaveLength(1);
        // ...while their runtime catalog hides the connection like any
        // non-member's. No is-admin plumbing into the executor.
        expect(
          (yield* admin.executor.tools.list()).filter((tool) => tool.integration === VERCEL),
        ).toEqual([]);
        expect(
          (yield* admin.executor.connections.list()).map((connection) =>
            String(connection.integration),
          ),
        ).toEqual(["github"]);
      }),
    ),
  );

  it.effect("subject-less and platform-view bindings stay unfiltered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tenant, dataDir } = yield* setupRestrictedWorkspace;

        // Subject-less org binding (the platform org API key shape): full org
        // visibility — a stated invariant, not fallout.
        const subjectless = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: null,
          dataDir,
        });
        const subjectlessTools = yield* subjectless.executor.tools.list();
        expect(
          subjectlessTools
            .filter((tool) => tool.integration === VERCEL)
            .map((tool) => String(tool.name)),
        ).toEqual(["deploy", "logs"]);
        expect(
          (yield* subjectless.executor.connections.list())
            .map((connection) => String(connection.integration))
            .sort(),
        ).toEqual(["github", "vercel"]);

        // The read-only platform view (admin plane) is deliberately
        // tenant-wide too.
        const platformConfig = makeTestConfig({ plugins, tenant, subject: null, dataDir });
        const platform = yield* createExecutor({ ...platformConfig, platformView: true });
        const platformTools = yield* platform.tools.list();
        expect(platformTools.filter((tool) => tool.integration === VERCEL)).toHaveLength(2);
        yield* platform.close().pipe(Effect.ignore);
      }),
    ),
  );
});
