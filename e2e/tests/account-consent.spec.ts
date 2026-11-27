import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { accountIdentityIssuer } from "../support/account-identity-issuer.ts";
import { accountIdentityProduct, IdentityAccount } from "../support/account-identity-product.ts";
import { body } from "../support/api.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Plan = Schema.Struct({
  status: Schema.Literals(["reuse", "consent-required", "incompatible"]),
  scopes: Schema.Array(Schema.String),
  missingScopes: Schema.Array(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});
const Resource = Schema.Struct({
  value: Schema.Struct({ subject: Schema.String, scopes: Schema.Array(Schema.String) }),
});
const Health = Schema.Struct({
  account: Schema.String,
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      check: Schema.NullOr(Schema.Struct({ current: Schema.Boolean })),
    }),
  ),
});
const Failure = Schema.Struct({ _tag: Schema.String, reason: Schema.String });
const State = Schema.Struct({ state: Schema.Struct({ status: Schema.String }) });

layer(TestLive, { excludeTestServices: true })("Shared account consent", (it) => {
  it.effect(scenarios.accountConsentBatch.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        const readApp = yield* product.deploy(issuer.origin, "Batch reader", ["read"]);
        const writeApp = yield* product.deploy(issuer.origin, "Batch writer", ["write"]);
        const first = yield* product.connection(readApp),
          second = yield* product.connection(writeApp);
        const additionalConnections = [{ connection: second, method: "oauth" }];
        const plan = yield* body(
          Plan,
          yield* product.request("POST", "/v1/account-connections/oauth/plan", {
            connection: first,
            method: "oauth",
            additionalConnections,
          }),
        );
        expect(plan).toMatchObject({ status: "consent-required", scopes: ["read", "write"] });
        const authorization = yield* product.authorize(first, { additionalConnections });
        expect(new URL(authorization.authorizationUrl).searchParams.get("scope")).toBe(
          "read write",
        );
        expect((yield* product.complete(first, authorization)).status).toBe(200);
        const read = yield* product.connectionAccount(first),
          write = yield* product.connectionAccount(second);
        expect(read.id).not.toBe(write.id);
        expect(read.identity?.id).toBe(write.identity?.id);
        expect(read.identity).toBeDefined();
        expect((yield* issuer.metrics).authorizations).toBe(1);
        for (const app of [readApp, writeApp]) expect((yield* product.read(app)).status).toBe(200);
        yield* serverControl("restart");
        const thirdApp = yield* product.deploy(issuer.origin, "Later reader", ["read"]);
        const fourthApp = yield* product.deploy(issuer.origin, "Later writer", ["write"]);
        const third = yield* product.connection(thirdApp),
          fourth = yield* product.connection(fourthApp);
        const extra = [{ connection: fourth, method: "oauth" }];
        expect(
          (yield* body(
            Plan,
            yield* product.request("POST", "/v1/account-connections/oauth/plan", {
              connection: third,
              method: "oauth",
              sourceAccount: read.id,
              additionalConnections: extra,
            }),
          )).status,
        ).toBe("reuse");
        expect((yield* product.reuseConnection(third, read.id, extra)).status).toBe("completed");
        expect((yield* product.connectionAccount(fourth)).identity?.id).toBe(read.identity?.id);
        for (const app of [thirdApp, fourthApp])
          expect((yield* product.read(app)).status).toBe(200);
        expect((yield* issuer.metrics).authorizations).toBe(1);
      }),
    ),
  );

  it.effect(scenarios.accountConsentUpgrade.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        const readApp = yield* product.deploy(issuer.origin, "Existing reader", ["read"]);
        const source = yield* product.connect(readApp, "custom-team-client");
        const siblingApp = yield* product.deploy(issuer.origin, "Shared reader", ["read"]);
        const reused = yield* product.reuse(siblingApp, source.id);
        expect(reused.status).toBe("completed");
        if (reused.status !== "completed") return;
        const checked = [
          { account: source.id, app: readApp },
          { account: reused.account.id, app: siblingApp },
        ];
        for (const item of checked) {
          const health = yield* body(
            Health,
            yield* product.request("POST", `/v1/accounts/${item.account}/health`, {
              apps: [item.app],
            }),
          );
          expect(health.apps[0]?.check?.current).toBe(true);
        }
        const writeApp = yield* product.deploy(issuer.origin, "New writer", ["write"]);
        const pending = yield* product.connection(writeApp);
        const planned = yield* body(
          Plan,
          yield* product.request("POST", "/v1/account-connections/oauth/plan", {
            connection: pending,
            method: "oauth",
            sourceAccount: source.id,
          }),
        );
        expect(planned).toMatchObject({
          status: "consent-required",
          scopes: ["read", "write"],
          missingScopes: ["write"],
        });
        const switched = yield* product.request("POST", "/v1/account-connections/oauth/start", {
          connection: pending,
          method: "oauth",
          sourceAccount: source.id,
          client: { clientId: "another-client" },
        });
        expect(switched.status).not.toBe(200);
        yield* issuer.configure({ expiresIn: 20, omitRefreshToken: true });
        const authorization = yield* product.authorize(pending, { sourceAccount: source.id });
        const params = new URL(authorization.authorizationUrl).searchParams;
        expect(params.get("client_id")).toBe("custom-team-client");
        expect(params.get("login_hint")).toBe("same@example.test");
        expect(params.get("scope")).toBe("read write");
        expect((yield* product.complete(pending, authorization)).status).toBe(200);
        const added = yield* product.connectionAccount(pending);
        expect(added.identity?.id).toBe(source.identity?.id);
        const health = yield* body(
          Schema.Array(Health),
          yield* product.request(
            "GET",
            `/v1/account-health?links=${encodeURIComponent(JSON.stringify(checked))}`,
          ),
        );
        for (const item of checked)
          expect(
            health.find((entry) => entry.account === item.account)?.apps[0]?.check?.current,
          ).toBe(false);
        const calls = yield* Effect.all([product.read(readApp), product.read(writeApp)], {
          concurrency: 2,
        });
        for (const response of calls) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect((yield* body(Resource, response)).value.scopes).toEqual(["read", "write"]);
        }
        expect((yield* issuer.metrics).refreshes).toBe(1);
        const retained = yield* body(
          IdentityAccount,
          yield* product.request("GET", `/v1/accounts/${source.id}`),
        );
        expect(retained.id).toBe(source.id);
        expect(retained.identity?.id).toBe(source.identity?.id);
        yield* serverControl("restart");
        expect((yield* product.read(readApp)).status).toBe(200);
        expect((yield* product.read(writeApp)).status).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.accountConsentRefusal.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        const readApp = yield* product.deploy(issuer.origin, "Protected reader", ["read"]);
        const source = yield* product.connect(readApp);
        const writeApp = yield* product.deploy(issuer.origin, "Unlinked writer", ["write"]);
        const pending = yield* product.connection(writeApp);
        yield* issuer.configure({ subject: "person-two" });
        const wrong = yield* product.consent(pending, { sourceAccount: source.id });
        expect(wrong.status).toBe(400);
        expect(yield* body(Failure, wrong)).toEqual({
          _tag: "OAuthCompletionFailed",
          reason: "identity_mismatch",
        });
        expect((yield* body(Resource, yield* product.read(readApp))).value.subject).toBe(
          "person-one",
        );
        expect((yield* product.read(writeApp)).status).not.toBe(200);
        yield* issuer.configure({ subject: "person-one", denied: true });
        const denied = yield* product.consent(pending, { sourceAccount: source.id });
        expect(yield* body(Failure, denied)).toEqual({
          _tag: "OAuthCompletionFailed",
          reason: "denied",
        });
        yield* issuer.configure({ denied: false, scopes: ["read"] });
        const partial = yield* product.consent(pending, { sourceAccount: source.id });
        expect(yield* body(Failure, partial)).toEqual({
          _tag: "OAuthCompletionFailed",
          reason: "scope_missing",
        });
        expect((yield* product.read(readApp)).status).toBe(200);
        expect((yield* product.read(writeApp)).status).not.toBe(200);
      }),
    ),
  );

  it.effect(scenarios.accountConsentStale.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        yield* issuer.configure({ expiresIn: 20 });
        const readApp = yield* product.deploy(issuer.origin, "Refreshing reader", ["read"]);
        const source = yield* product.connect(readApp);
        const writeApp = yield* product.deploy(issuer.origin, "Stale writer", ["write"]);
        const pending = yield* product.connection(writeApp);
        const authorization = yield* product.authorize(pending, { sourceAccount: source.id });
        expect((yield* product.read(readApp)).status).toBe(200);
        expect((yield* issuer.metrics).refreshes).toBe(1);
        const stale = yield* product.complete(pending, authorization);
        expect(yield* body(Failure, stale)).toEqual({
          _tag: "OAuthCompletionFailed",
          reason: "grant_changed",
        });
        expect((yield* product.read(readApp)).status).toBe(200);
        expect((yield* product.read(writeApp)).status).not.toBe(200);
        expect((yield* product.consent(pending, { sourceAccount: source.id })).status).toBe(200);
        yield* product.connectionAccount(pending);
        expect((yield* product.read(writeApp)).status).toBe(200);
        const secondIssuer = yield* accountIdentityIssuer;
        const resource = secondIssuer.origin + "/api-a";
        const a = yield* product.deploy(
          secondIssuer.origin,
          "Second provider A",
          ["read", "write"],
          { resource },
        );
        const second = yield* product.connect(a);
        const b = yield* product.deploy(secondIssuer.origin, "Second provider B", ["write"], {
          resource: secondIssuer.origin + "/api-b",
        });
        const other = yield* product.connection(b);
        expect(
          yield* body(
            Plan,
            yield* product.request("POST", "/v1/account-connections/oauth/plan", {
              connection: other,
              method: "oauth",
              sourceAccount: second.id,
            }),
          ),
        ).toMatchObject({ status: "incompatible", reason: "resource" });
        const changedApp = yield* product.deploy(issuer.origin, "Changed target", ["read"]);
        const changed = yield* product.connection(changedApp);
        const batchApp = yield* product.deploy(issuer.origin, "Batch rollback", ["write"]);
        const batch = yield* product.connection(batchApp);
        const batchAuth = yield* product.authorize(batch, {
          sourceAccount: source.id,
          additionalConnections: [{ connection: changed, method: "oauth" }],
        });
        yield* product.deploy(
          issuer.origin,
          "Changed target",
          ["read", "new-access"],
          {},
          changedApp,
        );
        expect((yield* product.complete(batch, batchAuth)).status).not.toBe(200);
        expect((yield* product.read(batchApp)).status).not.toBe(200);
        expect((yield* product.read(readApp)).status).toBe(200);
        expect(
          (yield* product.request("POST", `/v1/account-connections/${batch}/cancel`)).status,
        ).toBe(200);
        for (const connection of [batch, changed])
          expect(
            (yield* body(
              State,
              yield* product.request("GET", `/v1/account-connections/${connection}`),
            )).state.status,
          ).toBe("cancelled");
      }),
    ),
  );
});
