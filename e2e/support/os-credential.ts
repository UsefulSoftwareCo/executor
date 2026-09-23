/** Observe and remove only the OS credential created by a disposable first-launch scenario. */
import { createHash } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { Effect } from "effect";
import { driver } from "./platform.ts";

/** Keys stay inside this adapter; the scenario receives only their fingerprint or absence. */
export const testCredential = (id: string) =>
  Effect.gen(function* () {
    const entry = yield* driver("open test OS credential", () =>
      Promise.resolve(
        new AsyncEntry("com.usefulsoftware.executor.v2", id, {
          linux: { store: "secret-service" },
        }),
      ),
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
