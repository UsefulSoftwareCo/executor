import { BlobStore } from "@executor-js/sdk/core";
import { cloudBlobs } from "./blobs.ts";
import { cloudOrigin } from "./stage.ts";
import { PgClient } from "@effect/sql-pg";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { cloudEmulators } from "./emulators.ts";
import { FetchHttpClient } from "effect/unstable/http";
import { Onboarding, OnboardingUnavailable, TeamIconNotFound } from "../contracts/onboarding.ts";
import { companyLookupLive } from "../implementation/company-profile.ts";
import { makeOnboarding } from "../implementation/onboarding.ts";
import { cloudDatabaseConnection } from "./database.ts";

/** Resolve the secret at composition; each request owns its SQL client and company request. */
export const cloudOnboarding = Effect.gen(function* () {
  const blobs = yield* cloudBlobs;
  const origin = yield* cloudOrigin;
  const emulators = yield* cloudEmulators;
  const lookup = Option.isSome(emulators)
    ? companyLookupLive(
        Redacted.make(Redacted.value(emulators.value).company.token),
        `${Redacted.value(emulators.value).company.baseUrl}/v1/brand/retrieve`,
      )
    : companyLookupLive(yield* Config.Redacted("CONTEXT_DEV_API_KEY"));
  const connection = yield* cloudDatabaseConnection;
  const service = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const url = yield* connection.connectionString;
      const services = yield* Layer.build(
        PgClient.layer({
          url,
          maxConnections: 1,
          prepare: false,
          flushUnnamedParse: connection.flushUnnamedParse,
        }),
      );
      return yield* makeOnboarding({ origin }).pipe(
        Effect.provideService(BlobStore, blobs),
        Effect.provideContext(services),
        Effect.provide(lookup.pipe(Layer.provide(FetchHttpClient.layer))),
      );
    }),
  );
  return Layer.succeed(
    Onboarding,
    Onboarding.of({
      icon: (userId, owner, key) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.icon(userId, owner, key)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError((error) =>
            Schema.is(TeamIconNotFound)(error) ? error : new OnboardingUnavailable(),
          ),
        ),
      prepare: (userId) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.prepare(userId)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError(() => new OnboardingUnavailable()),
        ),
      create: (userId, details) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.create(userId, details)),
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError(() => new OnboardingUnavailable()),
        ),
    }),
  );
});
