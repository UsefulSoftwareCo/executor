import { BlobStore } from "@executor-js/sdk/core";
import { cloudBlobs } from "./blobs.ts";
import { cloudOrigin, productionStage, stageName } from "./stage.ts";
import { PgClient } from "@effect/sql-pg";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { cloudEmulators } from "./emulators.ts";
import type { EmulatedServices } from "../contracts/emulators.ts";
import { FetchHttpClient } from "effect/http";
import { Onboarding, OnboardingUnavailable, TeamIconNotFound } from "../contracts/onboarding.ts";
import { companyLookupLive } from "../implementation/company-profile.ts";
import { makeOnboarding } from "../implementation/onboarding.ts";
import { v1MembershipDisabled, v1MembershipLive } from "../implementation/v1-membership.ts";
import { cloudDatabaseConnection } from "./database.ts";
import {
  CheckSince,
  missingV1MembershipCheckSince,
  missingV1WorkosKey,
} from "./v1-membership-settings.ts";

const configured = (value: string) => value !== "";

/**
 * GitHub Actions passes an unset secret or variable as an empty string, so empty means unset.
 * Production (`v2`) requires v1's WorkOS key and `V1_MEMBERSHIP_CHECK_SINCE`, and refuses to
 * start, and so to deploy, without them. Elsewhere the check runs only where the key (or the
 * WorkOS emulator) is configured, and then requires the cutoff: without it, accounts that
 * already used v2 could be stopped. Self-host never composes this module.
 */
const cloudV1Membership = (
  emulators: Option.Option<Redacted.Redacted<typeof EmulatedServices.Type>>,
) =>
  Effect.gen(function* () {
    const production = Option.getOrUndefined(yield* stageName) === productionStage;
    const configuredKey = (yield* Config.Redacted("V1_WORKOS_API_KEY").pipe(Config.option)).pipe(
      Option.filter((value) => configured(Redacted.value(value))),
    );
    const since = (yield* Config.String("V1_MEMBERSHIP_CHECK_SINCE").pipe(Config.option)).pipe(
      Option.filter(configured),
    );
    if (production && Option.isNone(configuredKey))
      return yield* Effect.die(new Error(missingV1WorkosKey));
    if (production && Option.isNone(since))
      return yield* Effect.die(new Error(missingV1MembershipCheckSince));
    const key = Option.isSome(emulators)
      ? Option.some({
          baseUrl: Redacted.value(emulators.value).workos.baseUrl,
          key: Redacted.make(Redacted.value(emulators.value).workos.token),
        })
      : Option.map(configuredKey, (value) => ({ baseUrl: "https://api.workos.com", key: value }));
    if (Option.isNone(key)) return v1MembershipDisabled;
    if (Option.isNone(since))
      return yield* Effect.die(
        new Error("Set V1_MEMBERSHIP_CHECK_SINCE with v1's WorkOS key to enable the v1 check"),
      );
    return v1MembershipLive({
      ...key.value,
      since: yield* Schema.decodeUnknownEffect(CheckSince)(since.value).pipe(
        Effect.catch(() =>
          Effect.die(
            new Error(
              production
                ? missingV1MembershipCheckSince
                : "V1_MEMBERSHIP_CHECK_SINCE must be an ISO 8601 UTC timestamp",
            ),
          ),
        ),
      ),
    });
  });

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
  const v1 = yield* cloudV1Membership(emulators);
  const connection = yield* cloudDatabaseConnection;
  const service = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const url = yield* connection.connectionString;
      const services = yield* Layer.build(
        PgClient.layer({ url, maxConnections: 1, prepare: false }),
      );
      return yield* makeOnboarding({ origin }).pipe(
        Effect.provideService(BlobStore, blobs),
        Effect.provideContext(services),
        Effect.provide(Layer.mergeAll(lookup, v1).pipe(Layer.provide(FetchHttpClient.layer))),
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
      allowsOrganization: (userId) =>
        service.pipe(
          Effect.flatMap((onboarding) => onboarding.allowsOrganization(userId)),
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
