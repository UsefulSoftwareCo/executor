/**
 * A deployed Cloud stage serves HTTPS. The OAuth issuer takes `BETTER_AUTH_URL`'s scheme as
 * configured, and Better Auth no longer rewrites an HTTP issuer to HTTPS, so the deploy refuses a
 * plain-HTTP public origin before anything builds. Cloud development, which runs on a loopback
 * origin, keeps plain HTTP. A production deploy also needs the Cloud notes file the deploy writes
 * before it builds. Runs the deploy workflow's own settings check as a process.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const check = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/cloud/scripts/check-deploy-settings.ts"], {
        env: { PATH: process.env.PATH ?? "", ...env },
        extendEnv: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { exitCode, output: `${stdout}\n${stderr}` };
  }).pipe(Effect.scoped);

const valid = "Deploy settings are valid.";
const refusal =
  "BETTER_AUTH_URL must be an HTTPS origin without a trailing slash. Only Cloud development on a " +
  "loopback host may use plain HTTP.";

layer(NodeServices.layer, { excludeTestServices: true })("Cloud deploy origin", (it) => {
  it.effect(
    "a deployed Cloud stage refuses a plain-HTTP public origin, and Cloud development on loopback keeps HTTP",
    () =>
      Effect.gen(function* () {
        // A stage that configures its origin, as every stage but production and test stages does.
        for (const origin of ["http://cloud.example.test", "http://192.168.50.10:4788"]) {
          const refused = yield* check({ ALCHEMY_STAGE: "staging", BETTER_AUTH_URL: origin });
          expect(refused.exitCode, refused.output).not.toBe(0);
          expect(refused.output).toContain(refusal);
          expect(refused.output).not.toContain(valid);
        }
        const fs = yield* FileSystem.FileSystem;
        const notesFile = `${yield* fs.makeTempDirectoryScoped({ prefix: "executor-cloud-notes-" })}/notes.json`;
        yield* fs.writeFileString(notesFile, JSON.stringify({ notes: [] }));
        const production = {
          ALCHEMY_STAGE: "v2",
          OAUTH_PROXY_PRODUCTION_URL: "https://executor.sh",
          EXECUTOR_CLOUD_RELEASE_NOTES_FILE: notesFile,
        };
        const cleartextProduction = yield* check({
          ...production,
          BETTER_AUTH_URL: "http://v2.executor.sh",
        });
        expect(cleartextProduction.exitCode).not.toBe(0);
        expect(cleartextProduction.output).toContain(refusal);

        // HTTPS anywhere, plain HTTP on the loopback origins Cloud development and the emulated
        // Cloud target run on, and a test stage, whose origin is derived and always HTTPS.
        for (const env of [
          { ALCHEMY_STAGE: "staging", BETTER_AUTH_URL: "https://cloud.example.test" },
          { ALCHEMY_STAGE: "staging", BETTER_AUTH_URL: "http://127.0.0.1:4411" },
          { ALCHEMY_STAGE: "staging", BETTER_AUTH_URL: "http://localhost:4411" },
          { ...production, BETTER_AUTH_URL: "https://v2.executor.sh" },
          { ALCHEMY_STAGE: "test-preview" },
        ]) {
          const accepted = yield* check(env);
          expect(accepted.exitCode, `${JSON.stringify(env)}\n${accepted.output}`).toBe(0);
          expect(accepted.output).toContain(valid);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a production deploy refuses to build without Cloud's notes file the deploy writes, or with one that holds no such notes, and other stages need none",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-cloud-notes-" });
        const production = {
          ALCHEMY_STAGE: "v2",
          OAUTH_PROXY_PRODUCTION_URL: "https://executor.sh",
          BETTER_AUTH_URL: "https://v2.executor.sh",
        };
        const written = `${directory}/written.json`;
        yield* fs.writeFileString(
          written,
          JSON.stringify({ notes: [{ date: "2026-11-14", text: "Apps open from the sidebar." }] }),
        );
        const malformed = `${directory}/malformed.json`;
        yield* fs.writeFileString(malformed, JSON.stringify({ notes: [{ date: "yesterday" }] }));

        const without = yield* check(production);
        expect(without.exitCode).not.toBe(0);
        expect(without.output).toContain("EXECUTOR_CLOUD_RELEASE_NOTES_FILE is unset");
        expect(without.output).not.toContain(valid);
        for (const file of [`${directory}/missing.json`, malformed]) {
          const refused = yield* check({ ...production, EXECUTOR_CLOUD_RELEASE_NOTES_FILE: file });
          expect(refused.exitCode, file).not.toBe(0);
          expect(refused.output).toContain("Nothing was deployed.");
          expect(refused.output).not.toContain(valid);
        }
        const accepted = yield* check({
          ...production,
          EXECUTOR_CLOUD_RELEASE_NOTES_FILE: written,
        });
        expect(accepted.exitCode, accepted.output).toBe(0);
        expect(accepted.output).toContain(valid);
        // A stage no user sees builds without notes, and shows none.
        for (const env of [
          { ALCHEMY_STAGE: "staging", BETTER_AUTH_URL: "https://cloud.example.test" },
          { ALCHEMY_STAGE: "test-preview" },
        ]) {
          const other = yield* check(env);
          expect(other.exitCode, `${JSON.stringify(env)}\n${other.output}`).toBe(0);
        }
      }).pipe(Effect.scoped),
  );
});
