/** Observe and remove only the OS credential created by a disposable first-launch scenario. */
import { createHash } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { driver } from "./platform.ts";

const service = "com.usefulsoftware.executor.v2";

/**
 * Keys stay inside this adapter; the scenario receives only their fingerprint or absence.
 *
 * A macOS Keychain item opens only to the program that created it, and the release executable is
 * not this test process, so on macOS the fingerprint covers the item's attributes, including when
 * it was last modified, and never its secret. Linux and Windows stores have no per-program access.
 */
export const testCredential = (id: string) =>
  process.platform === "darwin" ? keychainCredential(id) : storeCredential(id);

const storeCredential = (id: string) =>
  Effect.gen(function* () {
    const entry = yield* driver("open test OS credential", () =>
      Promise.resolve(new AsyncEntry(service, id, { linux: { store: "secret-service" } })),
    );
    const remove = driver("remove test OS credential", () => entry.deleteCredential());
    return {
      remove,
      fingerprint: driver("read test OS credential fingerprint", (signal) =>
        entry.getPassword(signal),
      ).pipe(
        Effect.map((value) =>
          value === undefined || value === null
            ? undefined
            : createHash("sha256").update(value).digest("hex"),
        ),
      ),
    };
  });

const keychainCredential = (id: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const security = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make("security", [...args, "-s", service, "-a", id], {
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          const [code, stdout] = yield* Effect.all(
            [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.mkString)],
            { concurrency: "unbounded" },
          );
          return { code: Number(code), stdout };
        }),
      ).pipe(Effect.orDie);
    return {
      remove: security(["delete-generic-password"]).pipe(Effect.asVoid),
      fingerprint: security(["find-generic-password"]).pipe(
        Effect.map(({ code, stdout }) =>
          code === 0 ? createHash("sha256").update(stdout).digest("hex") : undefined,
        ),
      ),
    };
  });
