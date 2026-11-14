/**
 * Reading a retained workflow run checks each account it captured by the scope its requirement had
 * on the run's version: an app account by its current app link, a user account by the caller's
 * use, whatever later versions declare.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { unlinkAccount } from "../support/app-accounts.ts";
import { appLinksFixture, keyProvider, ok } from "../support/app-links.ts";
import { WorkflowRun } from "../support/workflow-app.ts";
import { scenarios } from "../test-plan.ts";

/** One requirement in `scope`, and a workflow that records the account it captured. */
const source = (
  scope: "app" | "user",
) => `import { defineApp, defineProvider, secrets, query, workflow, object, string, router } from "apps";
const service = ${keyProvider("Retained workflow fixture")};
export default defineApp({ ${scope}: { accounts: { service } } }, async () => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  workflows: { capture: workflow({ input: object({}) }, async (ctx) =>
    ctx.step.do("capture", async (step) => step.${scope}.accounts.service.id)) },
}));`;

layer(HostedLive, { excludeTestServices: true })("App account workflow history", (it) => {
  it.effect(scenarios.hostedRetainedWorkflowScopes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source("app") }]);
        const { api, actors, path, connect, unlink, link } = fixture;
        const start = (actor: Session, appPath: string) =>
          Effect.gen(function* () {
            const started = yield* api.request(actor, "POST", `${appPath}/workflow-runs`, {
              workflow: "capture",
              input: {},
            });
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            return (yield* body(Resource, started)).id;
          });
        const complete = (actor: Session, appPath: string, run: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 20_000;
            for (;;) {
              const read = yield* api.request(actor, "GET", `${appPath}/workflow-runs/${run}`);
              expect(read.status, JSON.stringify(read.body)).toBe(200);
              const state = yield* body(WorkflowRun, read);
              if (state.status === "complete") return state;
              expect(yield* Clock.currentTimeMillis, JSON.stringify(state)).toBeLessThan(deadline);
              yield* Effect.sleep("100 millis");
            }
          });
        const read = (actor: Session, appPath: string, run: string) =>
          api
            .request(actor, "GET", `${appPath}/workflow-runs/${run}`)
            .pipe(Effect.map((response) => response.status));

        // The owner's run captures the app's linked account, which is the owner's own. Once it is
        // unlinked, the owner can still use the account but not read the run's history.
        const own = yield* connect(actors.owner, "app", "service", "owner-service");
        const owned = yield* start(actors.owner, path);
        expect((yield* complete(actors.owner, path, owned)).output).toBe(own);
        yield* ok(yield* unlink(actors.owner, "service", own));
        expect(yield* read(actors.owner, path, owned)).toBe(403);
        expect(
          (yield* api.request(actors.owner, "GET", `${fixture.prefix}/accounts/${own}`)).status,
        ).toBe(200);
        yield* ok(yield* link(actors.owner, "service", own));
        expect(yield* read(actors.owner, path, owned)).toBe(200);

        // The owner's run captures their account for a user requirement. A later deployment makes
        // the requirement the app's, and the owner links that same account for everyone. The run
        // is still checked by the owner's use of it, not by the app link: once the app link goes,
        // the run stays readable, while a run on the new deployment that captured it as the app's
        // is refused.
        const later = yield* appLinksFixture([{ path: "index.ts", content: source("user") }]);
        const account = yield* later.connect(actors.owner, "user", "service", "user-service");
        const run = yield* start(actors.owner, later.path);
        expect((yield* complete(actors.owner, later.path, run)).output).toBe(account);
        yield* unlinkAccount(actors.owner, later.path, "service", account);
        expect(yield* read(actors.owner, later.path, run)).toBe(200);
        const redeployed = yield* api.request(actors.owner, "POST", `${later.path}/deploy`, {
          files: [{ path: "index.ts", content: source("app") }, appsManifest],
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        yield* ok(yield* later.link(actors.owner, "service", account));
        const appRun = yield* start(actors.owner, later.path);
        expect((yield* complete(actors.owner, later.path, appRun)).output).toBe(account);
        expect(yield* read(actors.owner, later.path, run)).toBe(200);
        yield* ok(yield* later.unlink(actors.owner, "service", account));
        expect(yield* read(actors.owner, later.path, run)).toBe(200);
        expect(yield* read(actors.owner, later.path, appRun)).toBe(403);
      }),
    ),
  );
});
