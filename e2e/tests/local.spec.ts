import { scenarios } from "../test-plan.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Api, body, BrowserCookies } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";

layer(TestLive, { excludeTestServices: true })("Local pairing", (it) => {
  it.effect(scenarios.local.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          anonymous = yield* api.session();
        expect((yield* api.request(anonymous, "GET", "/dashboard/api/overview")).status).toBe(401);
        // Pair issuance is deliberately not a browser-origin request.
        const pairing = yield* anonymous.send("POST", "/auth/pair", undefined, {
          authorization: `Bearer ${Redacted.value(target.apiKey)}`,
        });
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        const token = new URL(url).hash.slice("#pair=".length);
        yield* browser.use("Exchange the one-use local pairing link", (page) => page.goto(url));
        yield* browser.use("The paired dashboard is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        const cookies = yield* browser.use("Read the paired browser session", (page) =>
          page.context().cookies(),
        );
        const paired = yield* api.session(
          Redacted.make(yield* Schema.decodeUnknownEffect(BrowserCookies)(cookies)),
        );
        expect((yield* api.request(paired, "GET", "/dashboard/api/overview")).status).toBe(200);
        expect((yield* api.request(anonymous, "POST", "/auth/exchange", { token })).status).toBe(
          401,
        );
        yield* browser.use("Reload preserves the session", (page) => page.reload());
        yield* browser.use("Dashboard remains authenticated", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        // A packaged host must retain the compiler and framework, not only its HTTP shell.
        const deployed = yield* anonymous.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Release verification",
            files: [
              {
                path: "index.ts",
                content: `
            import { defineApp, query, object, string } from "apps";
            import isNumber from "is-number";
            export default defineApp({ accounts: {} }, {
              queries: { echo: query({ input: object({ value: string() }) }, async (_ctx, input) => ({ value: input.value, numeric: isNumber("2") })) },
            });
          `,
              },
              {
                path: "package.json",
                content: JSON.stringify({ dependencies: { "is-number": "7.0.0" } }),
              },
            ],
          },
          { authorization: `Bearer ${Redacted.value(target.apiKey)}` },
        );
        expect(deployed.status).toBe(200);
        const deployedApp = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String, slug: Schema.String }) }),
          deployed,
        );
        const called = yield* anonymous.send(
          "POST",
          "/v1/tools/call",
          {
            app: deployedApp.app.id,
            tool: "queries.echo",
            input: { value: "packaged-runtime-ok" },
          },
          { authorization: `Bearer ${Redacted.value(target.apiKey)}` },
        );
        expect(called.status).toBe(200);
        expect(called.body).toEqual({
          status: "completed",
          value: { value: "packaged-runtime-ok", numeric: true },
        });
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "executor-release-git-" });
        const git = (args: readonly string[]) =>
          processes.exitCode(
            ChildProcess.make("git", args, {
              cwd: checkout,
              extendEnv: true,
              env: {
                GIT_TERMINAL_PROMPT: "0",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
                GIT_CONFIG_COUNT: "2",
                GIT_CONFIG_KEY_0: "http.extraHeader",
                GIT_CONFIG_VALUE_0: `Authorization: Bearer ${Redacted.value(target.apiKey)}`,
                GIT_CONFIG_KEY_1: "commit.gpgsign",
                GIT_CONFIG_VALUE_1: "false",
                GIT_AUTHOR_NAME: "Release verification",
                GIT_AUTHOR_EMAIL: "release@example.test",
                GIT_COMMITTER_NAME: "Release verification",
                GIT_COMMITTER_EMAIL: "release@example.test",
              },
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
        expect(
          yield* git([
            "clone",
            "--quiet",
            `${target.metadata.origin}/git/local/${deployedApp.app.slug}.git`,
            ".",
          ]),
        ).toBe(0);
        yield* fs.writeFileString(
          `${checkout}/release-check.txt`,
          "Pushed through Git smart HTTP.\n",
        );
        expect(yield* git(["add", "release-check.txt"])).toBe(0);
        expect(yield* git(["commit", "--quiet", "-m", "Check source push"])).toBe(0);
        expect(yield* git(["push", "--quiet", "origin", "HEAD:main"])).toBe(0);
        const workspace = yield* body(
          Schema.Struct({
            files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
          }),
          yield* api.request(paired, "GET", `/api/apps/${deployedApp.app.id}/workspace`),
        );
        expect(workspace.files).toContainEqual({
          path: "release-check.txt",
          content: "Pushed through Git smart HTTP.\n",
        });
        yield* browser.checkpoint("Local dashboard paired and ready for manual use");
      }),
    ),
  );
});
