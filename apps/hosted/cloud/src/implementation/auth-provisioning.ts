/** Auth setup runs in a scoped Node deployment job, never in a Worker request. */
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { provisionHostedOAuthResources } from "@executor-js/hosted-server";
import { databaseUrl } from "@executor-js/hosted-server/database";
import { HostedMigrationFailed } from "@executor-js/hosted-server/migrations";
import { Config, Effect, Redacted } from "effect";
import { unavailableAuthEmail } from "../contracts/email.ts";
import { cloudAuthOptions, cloudAuthSettings } from "./auth-options.ts";

/** The caller's scope owns the setup pool; migrations and provisioning use the same options. */
export const cloudAuthSetup = Effect.gen(function* () {
  const url = yield* databaseUrl;
  const settings = yield* cloudAuthSettings;
  const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Pool({ connectionString: Redacted.value(url), max: 2 }),
      catch: () => new HostedMigrationFailed({ stage: "auth" }),
    }),
    (pool) => Effect.promise(() => pool.end()),
  );
  // Setup serves no requests; the limit stays at its default.
  const base = cloudAuthOptions({ ...settings, rateLimitEnabled: true }, [], unavailableAuthEmail);
  const options = {
    ...base,
    database,
    secret: Redacted.value(secret),
    advanced: { ...base.advanced, database: { validateSchema: false } },
  };
  const origins = {
    origin: settings.url,
    resourceOrigins: settings.resourceOrigins,
    issuer: settings.issuer,
  };
  const context = Effect.tryPromise({
    try: () => betterAuth(options).$context,
    catch: () => new HostedMigrationFailed({ stage: "auth" }),
  });
  const provision = Effect.gen(function* () {
    yield* provisionHostedOAuthResources(origins, yield* context).pipe(
      Effect.mapError(() => new HostedMigrationFailed({ stage: "auth" })),
    );
  });
  return { url, options, origins, context, provision };
});
