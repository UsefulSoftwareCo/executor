/** Importable environment lifecycle used by interactive tooling and scenario adapters. */
import { Clock, Effect, FileSystem, Path, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { randomBytes } from "node:crypto";
import { Target } from "../support/platform.ts";
import { startCloudEnvironment } from "../support/cloud-environment.ts";
import { startDeployment } from "./deployment.ts";
import { freePort } from "../support/ports.ts";

/** Acquire real infrastructure once. The caller's scope owns servers, fixtures, emulators and teardown. */
export const startEnvironment = (input: {
  readonly target: "local" | "self-host" | "cloud" | "deployed";
  readonly database?: "neon" | "planetscale";
  readonly headless?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = path.resolve(".local/testing", randomBytes(12).toString("hex"));
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const commit = (yield* processes.string(
      ChildProcess.make("git", ["rev-parse", "HEAD"]),
    )).trim();
    const dirty =
      (yield* processes.string(ChildProcess.make("git", ["status", "--porcelain"]))).trim().length >
      0;
    const origin = `http://localhost:${yield* freePort}`;
    const cloud =
      input.target === "deployed"
        ? yield* startDeployment(input.database === undefined ? {} : { database: input.database })
        : input.target === "cloud"
          ? yield* startCloudEnvironment({
              directory,
              origin,
              commit,
              observeUI: false,
              appPort: yield* freePort,
              databasePort: yield* freePort,
            })
          : undefined;
    const target = Target.of({
      directory,
      apiKey: Redacted.make(randomBytes(32).toString("hex")),
      rows: 1000,
      recordingPaceMs: 0,
      observeUI: false,
      headless: input.headless ?? false,
      ...(cloud === undefined ? {} : { fixtures: cloud.fixtures }),
      metadata: {
        target: input.target === "deployed" ? "cloud" : input.target,
        origin: cloud?.origin ?? origin,
        mode: input.target === "deployed" ? "attached" : "managed",
        runtime:
          input.target === "deployed"
            ? "Deployed Cloudflare stage"
            : input.target === "cloud"
              ? "Local Cloud Worker + Postgres"
              : "Isolated Node + PGlite per scenario",
        commit,
        dirty,
        startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        interactive: false,
        diagnostics: "diagnostics/index.html",
      },
    });
    return { target, cloud };
  });
