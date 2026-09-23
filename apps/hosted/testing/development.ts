/** Self-host development composition. Production never imports these shortcuts. */
import { authSettings } from "@executor-js/hosted-server";
import { Config, Effect, Schema } from "effect";
import { AuthDatabase } from "../self-host/src/contracts/database.ts";
import { TestAccountFailed, TestOrigin, testAccountAuth } from "./accounts.ts";
import { hostedDevtools } from "./hosted-tools.ts";

/** Validate the local HTTP listener before acquiring storage. */
export const developmentSettings = Effect.gen(function* () {
  yield* Config.String("NODE_ENV").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(["development", "test"]))),
  );
  const settings = yield* authSettings;
  const origin = yield* Schema.decodeUnknownEffect(TestOrigin)(settings.url);
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.port === "")
    return yield* new TestAccountFailed({ stage: "configuration" });
  yield* Config.NonEmptyString("EXECUTOR_DATA_DIR");
  return { origin, hostname: url.hostname, host: url.host, port: Number(url.port) };
});

/** Reuse the process-owned PGlite connection and the real self-host cookie configuration. */
export const developmentSignIn = (
  target: Effect.Success<typeof developmentSettings>,
  organization: string,
) =>
  Effect.gen(function* () {
    const settings = yield* authSettings;
    const database = yield* AuthDatabase;
    return yield* hostedDevtools({
      origin: target.origin,
      host: "self-host",
      organization,
      auth: testAccountAuth({
        origin: target.origin,
        secret: settings.secret,
        database,
        cookiePrefix: "executor-hosted",
      }),
    });
  });
