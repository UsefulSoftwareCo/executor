/** Node-only cloud dev tools. Imported by the local web process, never by the Worker. */
import { Pool } from "pg";
import { authSettings } from "@executor-js/hosted-server";
import { Config, Effect, Layer, Schema, Redacted } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";
import { cloudSessionCookiePrefix } from "../cloud/src/contracts/browser.ts";
import { TestAccountFailed, TestOrigin, testAccountAuth } from "./accounts.ts";
import { hostedDevtools } from "./hosted-tools.ts";

/** Acquire a local Postgres pool for the dev web lifetime and mount account shortcuts. */
export const cloudDevtools = Effect.gen(function* () {
  yield* Config.String("NODE_ENV").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(["development", "test"]))),
  );
  const settings = yield* authSettings;
  const origin = yield* Schema.decodeUnknownEffect(TestOrigin)(settings.url);
  const url = yield* Config.Redacted("DATABASE_URL").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LocalDatabaseUrl)),
  );
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Pool({ connectionString: Redacted.value(url), max: 2 }),
      catch: () => new TestAccountFailed({ stage: "database" }),
    }),
    (pool) => Effect.promise(() => pool.end()),
  );
  const handlers = yield* hostedDevtools({
    host: "cloud",
    origin,
    organization: "agent-tests",
    auth: testAccountAuth({
      origin,
      database,
      secret: settings.secret,
      cookiePrefix: cloudSessionCookiePrefix(origin),
    }),
  });
  return Layer.mergeAll(
    HttpRouter.add("GET", "/api/devtools", handlers.status),
    HttpRouter.add("POST", "/api/devtools/operator", handlers.signIn),
  );
});
