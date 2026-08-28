// ---------------------------------------------------------------------------
// What a health check persists.
//
// `connections.validate` writes its result into `connection.last_health`, so
// every field it returns is stored. The probed operation is user-chosen from
// the plugin's own catalog, which means it can be a key-listing endpoint just
// as easily as a `/me` — and the identity field can be pointed at anything the
// picker offered, including a key inside that listing.
//
// This runs the real probe against a real server rather than unit-testing the
// walkers, because the property under test is what survives the whole path into
// the database. The core walkers are covered separately in
// `packages/core/sdk/src/health-response-sample-redaction.test.ts`.
//
// Each `it` shares ONE server and executor across its probes: this file runs
// beside a Graph-scale spec compile that is already near its time budget, so it
// deliberately keeps its own setup cost down.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import {
  AuthTemplateSlug,
  IntegrationSlug,
  REDACTED_SAMPLE_VALUE,
  createExecutor,
  type HealthCheckResult,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { variable } from "@executor-js/sdk/http-auth";

import { serveOpenApiHttpApiTestServer } from "../testing";
import { openApiPlugin } from "./plugin";

/** The credential the connection authenticates with. Longer than the sample's
 *  120-char value cap on purpose: truncating before scrubbing would leave a
 *  120-char prefix of it that an exact-value scrub can no longer match. */
const CONNECTION_SECRET = `sk-conn-${"c".repeat(200)}`;

/** A DIFFERENT secret, the kind a key-listing endpoint returns. No scrub of the
 *  connection's own value can recognise this one; only its key can. */
const LISTED_SECRET = "sk-live-listed-must-not-be-persisted";

const AccountBody = Schema.Struct({
  plan: Schema.String,
  api_keys: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  /** The body echoing back the key it was authenticated with, under a name that
   *  says nothing about it. */
  lastRequestNote: Schema.String,
});

const AccountApi = HttpApi.make("keyListingApi").add(
  HttpApiGroup.make("account").add(
    HttpApiEndpoint.get("getAccount", "/account", { success: AccountBody }),
  ),
);

const AccountLive = HttpApiBuilder.group(AccountApi, "account", (handlers) =>
  handlers.handle("getAccount", () =>
    Effect.succeed({
      plan: "pro",
      api_keys: [{ name: "prod", value: LISTED_SECRET }],
      lastRequestNote: `authenticated with ${CONNECTION_SECRET}`,
    }),
  ),
);

/** Serve the key-listing API and build an executor once, then hand back a
 *  `probe` that registers the spec under its own slug (the identity field is
 *  baked into the integration config) and validates a credential against it.
 *  The returned value is the `HealthCheckResult` exactly as it is persisted. */
const withProbe = <A, E, R>(
  use: (
    probe: (identityField: string) => Effect.Effect<HealthCheckResult, unknown>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const server = yield* serveOpenApiHttpApiTestServer({
      api: AccountApi,
      handlersLayer: AccountLive,
    });
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
          memoryCredentialsPlugin(),
        ] as const,
      }),
    );

    let counter = 0;
    const probe = (identityField: string) =>
      Effect.gen(function* () {
        const slug = `key_listing_${counter++}`;
        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug,
          baseUrl: server.baseUrl,
          healthCheck: { operation: "account.getAccount", identityField },
          authenticationTemplate: [
            { slug: "apiKey", type: "apiKey", headers: { authorization: [variable("token")] } },
          ],
        });
        return yield* executor.connections.validate({
          owner: "org",
          integration: IntegrationSlug.make(slug),
          template: AuthTemplateSlug.make("apiKey"),
          value: CONNECTION_SECRET,
        });
      });

    return yield* use(probe);
  }).pipe(Effect.scoped);

describe("openapi health check redaction", () => {
  it.effect("redacts the persisted identity, whichever way the secret arrives", () =>
    withProbe((probe) =>
      Effect.gen(function* () {
        // The identity is read straight off the raw body by `extractIdentity`,
        // so it passes through neither the key redaction nor the value scrub
        // unless it is put through them explicitly.

        // Key reading: the identity field points inside a credential-named
        // array, where only the array's own key says what it holds.
        const listed = yield* probe("api_keys.0.value");
        expect(listed.status).toBe("healthy");
        expect(listed.identity).toBe(REDACTED_SAMPLE_VALUE);

        // Value reading: an innocent key name, but the value IS the secret we
        // authenticated with.
        const echoed = yield* probe("lastRequestNote");
        expect(echoed.identity).toContain(REDACTED_SAMPLE_VALUE);
        expect(echoed.identity).not.toContain("sk-conn-");

        // POSITIVE CONTROL. Without it, a checker that blanked everything would
        // satisfy both assertions above.
        const plan = yield* probe("plan");
        expect(plan.identity).toBe("pro");
      }),
    ),
  );

  it.effect("redacts both listed and echoed secrets in the persisted sample", () =>
    withProbe((probe) =>
      Effect.gen(function* () {
        const result = yield* probe("plan");
        const sample = Object.fromEntries(
          (result.responseSample ?? []).map((row) => [row.path, row.value]),
        );

        // The listed secret: only its enclosing array key names it.
        expect(sample["api_keys.0.value"]).toBe(REDACTED_SAMPLE_VALUE);

        // The echoed connection secret: only its exact value identifies it, and
        // it is longer than the 120-char cap. Scrubbing after truncation would
        // leave a recognisable prefix here.
        const note = sample["lastRequestNote"] ?? "";
        expect(note).toContain(REDACTED_SAMPLE_VALUE);
        expect(note).not.toContain("sk-conn-");

        // The preview still works.
        expect(sample["plan"]).toBe("pro");
      }),
    ),
  );
});
