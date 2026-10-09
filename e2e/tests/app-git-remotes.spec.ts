/**
 * Clients take an app's Git remote from the host, never from the origin they called: on Cloud the
 * API is `api.executor.sh` and remotes are on the edge (`executor.sh/git/...`). Git clones and
 * pushes through the remote the CLI and the dashboard show, with the session
 * `executor apps login` saved at the API host, and earlier clones' remotes on the deployment origin
 * (`v2.executor.sh`) keep working. Self-host serves all of these on its one origin.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsCli } from "../support/apps-cli.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpConsent } from "../support/mcp-consent.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String, slug: Schema.String });
const Workspace = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

layer(HostedLive, { excludeTestServices: true })("App Git remotes", (it) => {
  it.effect(
    scenarios.appGitRemotes.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const hosts = targetHosts(yield* Target);
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser;
          const tools = yield* appsCli;
          const login = yield* tools.login(hosts.api);
          expect(login.finished.code, login.finished.stderr).toBe(0);

          const prefix = `/api/organizations/${actors.organization.id}/apps`;
          const created = yield* api.request(actors.owner, "POST", prefix, {
            name: `Git remote ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: 'export default "remote";' }],
          });
          expect(created.status).toBe(200);
          const app = yield* body(App, created);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
          );
          const path = `/git/${actors.organization.id}/${app.slug}.git`;
          const remote = `${hosts.edge}${path}`;

          const printed = yield* tools.cli(["git", "--host", hosts.api, "--app", app.id]);
          expect(printed.code, printed.stderr).toBe(0);
          expect(printed.stdout.trim()).toBe(remote);

          // The dashboard shows the same remote, not one on its own origin.
          yield* browser.use("Open the app's source", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=source`),
          );
          yield* browser.use("Open the clone details", (page) =>
            page.getByRole("button", { name: "Clone", exact: true }).click(),
          );
          expect(
            yield* browser.use("Read the dashboard's clone URL", (page) =>
              page.getByLabel("Git clone URL").inputValue(),
            ),
          ).toBe(remote);
          yield* browser.checkpoint("The dashboard shows the host's remote");

          // Git clones and pushes through it with the CLI's session.
          const cloned = yield* tools.git(["clone", "--quiet", remote, "."]);
          expect(cloned.code, cloned.stderr).toBe(0);
          const pushed = { path: "pushed.txt", content: `Pushed ${randomUUID()}\n` };
          yield* tools.fs.writeFileString(
            tools.path.join(tools.checkout, pushed.path),
            pushed.content,
          );
          expect((yield* tools.git(["add", pushed.path])).code).toBe(0);
          expect((yield* tools.git(["commit", "--quiet", "-m", "Push to the remote"])).code).toBe(
            0,
          );
          const push = yield* tools.git(["push", "--quiet", "origin", "HEAD:main"]);
          expect(push.code, push.stderr).toBe(0);
          const workspace = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/workspace`),
          );
          expect(workspace.files).toContainEqual(pushed);

          // A remote on the deployment origin, as earlier clones have, serves the same history.
          const earlier = yield* tools.git([
            "fetch",
            "--quiet",
            `${hosts.deployment}${path}`,
            "main",
          ]);
          expect(earlier.code, earlier.stderr).toBe(0);
          const heads = yield* tools.git(["rev-parse", "FETCH_HEAD", "HEAD"]);
          const [fetched, local] = heads.stdout.trim().split("\n");
          expect(fetched).toBe(local);
        }).pipe(Effect.provide(McpConsent.layer)),
      ),
    // Signs in through the browser, runs the CLI several times, and clones and pushes over HTTP.
    { timeout: 120_000 },
  );
});
