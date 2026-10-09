import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { createProfile } from "../support/profiles.ts";
import { withApps } from "../support/apps-release.ts";
import { strictTypeProblems } from "../support/apps-package.ts";

/** The tools.md example: `resolve` returns a `query()` with no cast. */
const files = [
  {
    path: "index.ts",
    content: `
import { defineApp, dynamicRouter, query, object } from "apps";
export default defineApp({ accounts: {} }, {
  tools: dynamicRouter({
    list: async () => [{ name: "ping", description: "Return pong", inputSchema: { type: "object", properties: {} }, readOnly: true }],
    resolve: async name => name === "ping" ? query({ input: object({}) }, async () => "pong") : undefined,
  }),
});
`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ type: "module", dependencies: withApps() }),
  },
];

/**
 * App source strict mode must reject: `resolve` returns `operation`, which a dynamic router cannot
 * serve to this app. `repo` needs a GitHub account the app does not declare.
 */
const rejectedFiles = (operation: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, dynamicRouter, object, query, router, secrets, string, type QueryContext } from "apps";
const github = defineProvider({ name: "GitHub", auth: { token: secrets({ label: "Token", fields: object({ token: string() }) }) } });
const ping = query({ input: object({}) }, async () => "pong");
const repo = query({ input: object({}) }, async (ctx: QueryContext<{ accounts: { github: typeof github } }>) => ctx.accounts.github.id);
export default defineApp({ accounts: {} }, {
  tools: dynamicRouter({ list: async () => [], resolve: async () => ${operation} }),
});
`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ type: "module", dependencies: withApps() }),
  },
];

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.dynamicOnlyApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        // deploy.md's local check passes before the app deploys.
        expect(yield* strictTypeProblems(files)).toEqual([]);
        // The router keeps the resolved handler's context, so defineApp sees the missing account.
        expect(yield* strictTypeProblems(rejectedFiles("repo"))).toEqual([
          {
            file: "index.ts",
            line: 5,
            code: 2741,
            message: expect.stringMatching(
              /^Property 'github' is missing in type '\{\}' but required/,
            ),
          },
        ]);
        // `resolve` returns one operation, not a router.
        expect(yield* strictTypeProblems(rejectedFiles("router({ ping })"))).toEqual([
          {
            file: "index.ts",
            line: 6,
            code: 2322,
            message: expect.stringContaining(
              `Type 'RouterDeclaration<QueryContext, unknown>' is missing the following properties from type 'Pick<OperationDeclaration<"mutation" | "query", never>, "kind" | unique symbol>': kind, [NativeOperation]`,
            ),
          },
        ]);
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const dynamicOnly = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Dynamic only ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(dynamicOnly.status).toBe(200);
        const dynamicPath = `${prefix}/${(yield* body(App, dynamicOnly)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", dynamicPath).pipe(Effect.orDie),
        );
        const dynamicProfile = yield* createProfile(actors.owner, dynamicPath);
        const dynamicResult = yield* api.request(
          actors.owner,
          "POST",
          `${dynamicPath}/tools/call`,
          {
            profile: dynamicProfile.id,
            tool: "ping",
            kind: "query",
            input: {},
          },
        );
        expect(dynamicResult.status).toBe(200);
        expect(yield* body(Schema.String, dynamicResult)).toBe("pong");
      }),
    ),
  );
});
