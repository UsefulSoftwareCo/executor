/**
 * Clients take an app's Git remote from the host, never from the origin they called: on Cloud the
 * API is `api.executor.sh` and remotes are on the edge (`executor.sh/git/...`). Git clones and
 * pushes through the remote the CLI and the dashboard show, with the session
 * `executor apps login` saved at the API host, and earlier clones' remotes on the deployment origin
 * (`v2.executor.sh`) keep working. Self-host serves all of these on its one origin.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsCli } from "../support/apps-cli.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
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

          // A pack over Git's 1 MiB http.postBuffer is sent after a probe request whose body is
          // only a flush packet, then streamed in chunks. Both must reach the repository.
          const large = { path: "large.txt", content: randomBytes(1536 * 1024).toString("base64") };
          yield* tools.fs.writeFileString(
            tools.path.join(tools.checkout, large.path),
            large.content,
          );
          expect((yield* tools.git(["add", large.path])).code).toBe(0);
          expect((yield* tools.git(["commit", "--quiet", "-m", "Push a large file"])).code).toBe(0);
          const largePush = yield* tools.git(["push", "--verbose", "origin", "HEAD:main"]);
          expect(largePush.code, largePush.stderr).toBe(0);
          expect(largePush.stderr).toContain("POST git-receive-pack (chunked)");
          const afterLarge = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/workspace`),
          );
          expect(afterLarge.files.find((file) => file.path === large.path)?.content.length).toBe(
            large.content.length,
          );

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

          const remoteMain = Effect.map(
            tools.git(["ls-remote", "origin", "refs/heads/main"]),
            (listed) => listed.stdout.split("\t")[0],
          );
          // A push far larger than one Worker could hold streams through to the repository. Each
          // file stays under Artifacts' 32 MB blob limit and the pack under the 64 MiB that
          // Artifacts accepts in one push today; random bytes keep the pack that large.
          const hugeFiles = ["huge-1.bin", "huge-2.bin", "huge-3.bin"];
          const beforeHuge = (yield* tools.git(["rev-parse", "HEAD"])).stdout.trim();
          for (const file of hugeFiles)
            yield* tools.fs.writeFile(
              tools.path.join(tools.checkout, file),
              randomBytes(14 * 1024 * 1024),
            );
          expect((yield* tools.git(["add", ...hugeFiles])).code).toBe(0);
          expect((yield* tools.git(["commit", "--quiet", "-m", "Push 42 MiB"])).code).toBe(0);
          const hugePush = yield* tools.git(["push", "origin", "HEAD:main"]);
          expect(hugePush.code, hugePush.stderr).toBe(0);
          expect(yield* remoteMain).toBe((yield* tools.git(["rev-parse", "HEAD"])).stdout.trim());

          // Pushes that would move a protected ref are refused the way Git reports them, and
          // nothing changes: main cannot be deleted, and __executor/ branches are Executor's.
          const deleted = yield* tools.git(["push", "origin", ":main"]);
          expect(deleted.code).not.toBe(0);
          expect(deleted.stderr).toContain("the app's main branch cannot be deleted");
          const retained = yield* tools.git(["push", "origin", "HEAD:refs/heads/__executor/x"]);
          expect(retained.code).not.toBe(0);
          expect(retained.stderr).toContain("Executor keeps this ref for retained versions");
          expect(yield* remoteMain).toBe((yield* tools.git(["rev-parse", "HEAD"])).stdout.trim());

          // With the large files removed, the history holds more than a Worker reads in one Git
          // response, but the current tree is small. A source read fetches only the commit it
          // reads, an older one by its SHA included, and the history lists commits without files.
          const hugeCommit = (yield* tools.git(["rev-parse", "HEAD"])).stdout.trim();
          expect((yield* tools.git(["rm", "--quiet", ...hugeFiles])).code).toBe(0);
          expect((yield* tools.git(["commit", "--quiet", "-m", "Remove 42 MiB"])).code).toBe(0);
          const trimmed = yield* tools.git(["push", "--quiet", "origin", "HEAD:main"]);
          expect(trimmed.code, trimmed.stderr).toBe(0);
          const trimmedCommit = (yield* tools.git(["rev-parse", "HEAD"])).stdout.trim();
          const current = yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/workspace`);
          expect(current.status).toBe(200);
          const currentFiles = (yield* body(Workspace, current)).files;
          expect(currentFiles).toContainEqual(pushed);
          expect(currentFiles.map((file) => file.path)).not.toContain(hugeFiles[0]);
          const history = yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/history`);
          expect(history.status, JSON.stringify(history.body)).toBe(200);
          const commits = (yield* body(
            Schema.Array(Schema.Struct({ commit: Schema.String })),
            history,
          )).map((entry) => entry.commit);
          expect(commits.slice(0, 2)).toEqual([trimmedCommit, hugeCommit]);
          expect(commits).toContain(beforeHuge);
          const older = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/${app.id}/commits/${beforeHuge}/display/file?path=${pushed.path}`,
          );
          expect(older.status, JSON.stringify(older.body)).toBe(200);
          expect((yield* body(Schema.Struct({ content: Schema.String }), older)).content).toBe(
            pushed.content,
          );
          // One commit whose own files are over the limit is refused as such.
          const oversized = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/${app.id}/commits/${hugeCommit}/display/file?path=${pushed.path}`,
          );
          expect(oversized.status).toBe(413);
          expect(yield* body(Schema.Struct({ reason: Schema.String }), oversized)).toEqual({
            reason: "limit",
          });

          // A shallow clone's push starts with its shallow boundary, and is accepted.
          const shallow = tools.path.join(tools.checkout, "..", "shallow");
          const shallowClone = yield* tools.git([
            "clone",
            "--quiet",
            "--depth",
            "1",
            remote,
            shallow,
          ]);
          expect(shallowClone.code, shallowClone.stderr).toBe(0);
          yield* tools.fs.writeFileString(tools.path.join(shallow, "shallow.txt"), "Shallow\n");
          expect((yield* tools.git(["-C", shallow, "add", "shallow.txt"])).code).toBe(0);
          expect(
            (yield* tools.git([
              "-C",
              shallow,
              "commit",
              "--quiet",
              "-m",
              "Push from a shallow clone",
            ])).code,
          ).toBe(0);
          const shallowPush = yield* tools.git(["-C", shallow, "push", "origin", "HEAD:main"]);
          expect(shallowPush.code, shallowPush.stderr).toBe(0);
          expect((yield* tools.git(["pull", "--quiet", "--ff-only", "origin", "main"])).code).toBe(
            0,
          );

          // The dashboard shows the same remote, not one on its own origin. The browser records
          // its page until the case ends, and Playwright encodes the time a page shows no change
          // only when it closes; a page opened before the Git steps above would leave minutes of
          // video to encode while the case cleans up.
          yield* browser.login(actors.owner);
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
        }),
      ),
    // Signs in through the browser, runs the CLI several times, and clones and pushes over HTTP,
    // including a 42 MiB push.
    { timeout: 240_000 },
  );

  // Git sends a stored credential from every helper before asking the next one, and stores what
  // the CLI's helper returns in all of them, as Git's default macOS configuration does with the
  // keychain. A copy kept past the access token's expiry is refused as a failed sign-in.
  it.effect(
    scenarios.appGitKeptCredentials.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const hosts = targetHosts(yield* Target);
          const api = yield* Api,
            actors = yield* Actors;
          const tools = yield* appsCli;
          const login = yield* tools.login(hosts.api);
          expect(login.finished.code, login.finished.stderr).toBe(0);
          const prefix = `/api/organizations/${actors.organization.id}/apps`;
          const created = yield* api.request(actors.owner, "POST", prefix, {
            name: `Kept credential ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: 'export default "kept";' }],
          });
          expect(created.status).toBe(200);
          const app = yield* body(App, created);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
          );
          const remote = `${hosts.edge}/git/${actors.organization.id}/${app.slug}.git`;

          // A helper that keeps whatever Git stores, every attribute included, as the keychain
          // does. Repository configuration comes before the CLI's helper, as system configuration
          // does for a user's own.
          const kept = tools.path.join(tools.home, "..", "kept-credential");
          const keeper = tools.path.join(tools.home, "..", "keeping-helper");
          yield* tools.fs.writeFileString(
            keeper,
            [
              "#!/bin/sh",
              'case "$1" in',
              `  get) [ -f '${kept}' ] && grep -E '^(username|password|password_expiry_utc)=' '${kept}' ;;`,
              `  store) cat > '${kept}' ;;`,
              `  erase) rm -f '${kept}' ;;`,
              "esac",
              "exit 0",
              "",
            ].join("\n"),
            { mode: 0o755 },
          );
          expect((yield* tools.git(["init", "--quiet"])).code).toBe(0);
          expect((yield* tools.git(["config", "credential.helper", keeper])).code).toBe(0);

          // The CLI's saved session nears the point where it refreshes: twenty seconds remain
          // before its last minute.
          const store = tools.path.join(tools.home, "..", "store.json");
          const sessionKey = `Executor Registry\n${hosts.api}`;
          const Store = Schema.Record(Schema.String, Schema.String);
          const Session = Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.Number });
          const readStore = Effect.flatMap(
            tools.fs.readFileString(store),
            Schema.decodeUnknownEffect(Schema.fromJsonString(Store)),
          );
          const session = Effect.flatMap(readStore, (entries) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(Session))(entries[sessionKey]),
          );
          const entries = yield* readStore;
          const saved = JSON.parse(entries[sessionKey] ?? "{}");
          yield* tools.fs.writeFileString(
            store,
            JSON.stringify({
              ...entries,
              [sessionKey]: JSON.stringify({ ...saved, expiresAt: Date.now() + 80_000 }),
            }),
          );
          const before = yield* session;

          const first = yield* tools.git(["ls-remote", remote]);
          expect(first.code, first.stderr).toBe(0);
          // The keeping helper now holds the CLI's token. Compared as booleans so a failure never
          // prints a token.
          const keeps = (token: string) =>
            Effect.map(tools.fs.readFileString(kept), (text) =>
              text.split("\n").includes(`password=${token}`),
            );
          expect(yield* keeps(before.accessToken), "the kept copy is the CLI's token").toBe(true);

          // Past the CLI's refresh point Git must not send the kept copy, which the host would
          // refuse once the token expires; the CLI's helper refreshes the session instead.
          yield* Effect.sleep(Duration.millis(before.expiresAt - 60_000 + 2000 - Date.now()));
          const second = yield* tools.git(["ls-remote", remote]);
          expect(second.code, second.stderr).toBe(0);
          const after = yield* session;
          expect(after.accessToken === before.accessToken, "the session was refreshed").toBe(false);
          expect(after.expiresAt).toBeGreaterThan(before.expiresAt);
          expect(yield* keeps(after.accessToken), "Git kept the refreshed token").toBe(true);
        }),
      ),
    // Signs in, waits about twenty seconds for the CLI's refresh point, and runs Git twice.
    { timeout: 120_000 },
  );
});
