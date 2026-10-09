/** Working-source reads follow every kind of write, including when Cloud has stored the old source. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Committed, Workspace } from "../support/app-authoring.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { storedWorkspace } from "../support/workspace-cache.ts";

const App = Schema.Struct({ id: Schema.String });
const Display = Schema.Struct({
  revision: Schema.Struct({ commit: Schema.String }),
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
});
const files = (value: string) => [
  { path: "index.ts", content: `export default ${JSON.stringify(value)};` },
];

layer(HostedLive, { excludeTestServices: true })("Workspace source writes", (it) => {
  it.effect(scenarios.workspaceSourceWrites.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const created = yield* api.request(actors.owner, "POST", prefix, {
          name: `Source writes ${randomUUID().slice(0, 8)}`,
          files: files("initial"),
        });
        expect(created.status).toBe(200);
        const app = yield* body(App, created);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const path = `${prefix}/${app.id}`;
        const read = Effect.gen(function* () {
          const response = yield* api.request(actors.owner, "GET", `${path}/workspace`);
          expect(response.status).toBe(200);
          return yield* body(Workspace, response);
        });
        // Cloud keeps the working source only while no write has replaced it.
        const stored = (label: string, expected: typeof Workspace.Type) =>
          target.metadata.target === "cloud" ? storedWorkspace(label, read, expected) : Effect.void;
        const initial = yield* read;

        const keyResponse = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Git push verification",
        });
        expect(keyResponse.status).toBe(200);
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          keyResponse,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const git = yield* body(
          Schema.Struct({ path: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/git`),
        );
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "executor-source-push-" });
        const run = (args: ReadonlyArray<string>) =>
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
                GIT_CONFIG_VALUE_0: `Authorization: Bearer ${Redacted.value(key.key)}`,
                GIT_CONFIG_KEY_1: "commit.gpgsign",
                GIT_CONFIG_VALUE_1: "false",
                GIT_AUTHOR_NAME: "Source verification",
                GIT_AUTHOR_EMAIL: "source@example.test",
                GIT_COMMITTER_NAME: "Source verification",
                GIT_COMMITTER_EMAIL: "source@example.test",
              },
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
        expect(yield* run(["clone", "--quiet", `${target.metadata.origin}${git.path}`, "."])).toBe(
          0,
        );

        // An ordinary Git push replaces the source that the next API and dashboard reads return.
        yield* stored("before-push", initial);
        const pushedFile = { path: "pushed.txt", content: `Pushed ${randomUUID()}\n` };
        yield* fs.writeFileString(`${checkout}/${pushedFile.path}`, pushedFile.content);
        expect(yield* run(["add", pushedFile.path])).toBe(0);
        expect(yield* run(["commit", "--quiet", "-m", "Push source"])).toBe(0);
        expect(yield* run(["push", "--quiet", "origin", "HEAD:main"])).toBe(0);
        const pushed = yield* read;
        expect(pushed.revision.commit).not.toBe(initial.revision.commit);
        const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
        expect(pushed.files.toSorted(byPath)).toEqual(
          [...initial.files, pushedFile].toSorted(byPath),
        );
        const displayed = yield* body(
          Display,
          yield* api.request(actors.owner, "GET", `${path}/workspace/display`),
        );
        expect(displayed.revision.commit).toBe(pushed.revision.commit);
        expect(displayed.files.map((file) => file.path)).toContain(pushedFile.path);

        // A commit through the API replaces the stored source before it returns.
        yield* stored("before-commit", pushed);
        const committed = yield* api.request(actors.owner, "POST", `${path}/commits`, {
          expected: pushed.revision.commit,
          files: files("committed"),
          message: "Commit source",
        });
        expect(committed.status).toBe(200);
        expect(yield* read).toEqual({
          revision: (yield* body(Committed, committed)).revision,
          files: files("committed"),
        });
      }),
    ),
  );
});
