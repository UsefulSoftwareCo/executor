import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { Organization, Resource } from "../support/contracts.ts";
import { type DeliveredSpan, Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { removalRevocationBudgetMs } from "../support/removal-revocation-budget.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Detail = Schema.Struct({ revocation: Schema.Literals(["automatic", "manual"]) });
const Status = Schema.Array(Schema.Struct({ status: Schema.Literals(["running", "done"]) }));
class StillRunning extends Error {}
class NotDelivered extends Error {}

const organization = (name: string) =>
  Effect.gen(function* () {
    const actors = yield* Actors,
      api = yield* Api,
      locks = yield* cloudLocks;
    const suffix = randomUUID().slice(0, 8);
    const created = yield* body(
      Organization,
      yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
        name: `${name} ${suffix}`,
        slug: `${name.toLowerCase()}-${suffix}`,
        keepCurrentActiveOrganization: true,
      }),
    );
    const prefix = `/api/organizations/${created.id}`;
    let removed = false;
    yield* Effect.addFinalizer(() =>
      removed ? Effect.void : api.request(actors.owner, "DELETE", prefix).pipe(Effect.ignore),
    );
    const remove = Effect.gen(function* () {
      const accepted = yield* api.request(actors.owner, "DELETE", prefix);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      removed = true;
      expect(accepted.body).toMatchObject({ organization: created.id });
      yield* locks
        .run({
          sql: "select status from hosted_organization_removal where organization_id = $1",
          params: [created.id],
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Status)),
          Effect.flatMap((rows) =>
            rows[0]?.status === "done"
              ? Effect.void
              : Effect.fail(new StillRunning(`Removal of ${created.id} has not finished`)),
          ),
          Effect.retry({
            while: (error) => error instanceof StillRunning,
            schedule: Schedule.spaced("500 millis"),
          }),
          Effect.timeout("60 seconds"),
        );
    });
    return { id: created.id, prefix, suffix, remove };
  });

const oauthApp = (prefix: string, name: string, issuer: string) =>
  Effect.gen(function* () {
    const actors = yield* Actors,
      api = yield* Api,
      http = yield* HttpClient.HttpClient;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name,
      files: oauthMcpAppFiles(name, `${issuer}/mcp`),
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(Resource, deployed);
    return (label: string) =>
      Effect.gen(function* () {
        const connection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {},
          ),
        );
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { authorizationUrl } = yield* body(SignIn, started);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("Issuer did not return a callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        return yield* body(Resource, completed);
      });
  });

layer(HostedLive, { excludeTestServices: true })("Organization removal revocation", (it) => {
  it.effect(scenarios.organizationRemovalRevocation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ refreshTokens: true, revocation: "recorded" });
        const created = yield* organization("Revoked");

        const account = yield* evidence.step(
          "The organization holds an account signed in with OAuth",
          Effect.gen(function* () {
            const signIn = yield* oauthApp(
              created.prefix,
              `Revoked ${created.suffix} service`,
              issuer.origin,
            );
            const saved = yield* signIn("Organization account");
            const detail = yield* api.request(
              actors.owner,
              "GET",
              `${created.prefix}/accounts/${saved.id}`,
            );
            expect(yield* body(Detail, detail)).toEqual({ revocation: "automatic" });
            return saved;
          }),
        );
        expect((yield* issuer.metrics).revocations).toEqual([]);

        yield* evidence.step(
          "The owner removes the organization and its removal finishes",
          Effect.gen(function* () {
            yield* created.remove;
            expect(
              (yield* api.request(actors.owner, "GET", `${created.prefix}/accounts/${account.id}`))
                .status,
            ).toBe(403);
          }),
        );

        expect((yield* issuer.metrics).revocations).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
        ]);
      }),
    ),
  );

  it.effect(scenarios.organizationRemovalRevocationBudget.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ refreshTokens: true, revocation: "stalled" });
        const created = yield* organization("Unrevoked");
        const accounts = 10;

        yield* evidence.step(
          `The organization holds ${accounts} accounts signed in with OAuth`,
          Effect.gen(function* () {
            const signIn = yield* oauthApp(
              created.prefix,
              `Unrevoked ${created.suffix} service`,
              issuer.origin,
            );
            for (let index = 0; index < accounts; index++)
              yield* signIn(`Organization account ${index + 1}`);
          }),
        );

        yield* evidence.step(
          "The owner removes the organization and its removal finishes",
          created.remove,
        );
        yield* evidence.step(
          "Eight revocations reached the service",
          issuer.revocationArrivals(8).pipe(Effect.timeout("10 seconds")),
        );
        const { revocationArrivals, revocations } = yield* issuer.metrics;
        expect(revocationArrivals).toBe(8);
        for (const revoked of revocations)
          expect(revoked).toEqual({
            token: "refresh",
            hint: "refresh_token",
            clientAuthenticated: true,
          });

        const counts = yield* evidence.step(
          "The purge records how many grants it did not revoke",
          Effect.gen(function* () {
            const steps = yield* telemetry
              .search(
                "organization.removal.step",
                { organization: created.id },
                { "executor.removal.step": "purge-owner-store" },
              )
              .pipe(
                Effect.flatMap((found) =>
                  found.data.length > 0
                    ? Effect.succeed(found.data.map(({ traceId }) => traceId))
                    : Effect.fail(new NotDelivered("The purge step's span has not arrived")),
                ),
                Effect.retry({
                  while: (error) => error instanceof NotDelivered,
                  schedule: Schedule.spaced("500 millis"),
                  times: 40,
                }),
              );
            const purge = (spans: ReadonlyArray<DeliveredSpan>) =>
              spans.find(
                (span) =>
                  span.operationName === "sdk.owners.remove" &&
                  span.tags["oauth.revocation.grants"] === String(accounts),
              );
            const revoked = (spans: ReadonlyArray<DeliveredSpan>, parent: DeliveredSpan) =>
              spans.filter(
                (span) =>
                  span.operationName === "oauth.revokeGrant" && span.parentSpanId === parent.spanId,
              );
            const spans = yield* telemetry.settled(steps, (spans) => {
              const found = purge(spans);
              return found !== undefined && revoked(spans, found).length >= 8;
            });
            const found = purge(spans);
            if (found === undefined) return yield* Effect.die("The purge's span went missing");
            const revocationSpans = revoked(spans, found);
            const end = Date.parse(found.startTime) + found.durationMs;
            const firstRevocation = Math.min(
              ...revocationSpans.map((span) => Date.parse(span.startTime)),
            );
            const logs = yield* Effect.forEach(steps, telemetry.logs);
            return {
              grants: found.tags["oauth.revocation.grants"],
              settled: found.tags["oauth.revocation.settled"],
              cutOff: found.tags["oauth.revocation.cut_off"],
              unattempted: found.tags["oauth.revocation.unattempted"],
              revocationSpans: revocationSpans.length,
              warned: logs.some((records) => records.includes("stopped revoking OAuth grants")),
              purgeMs: found.durationMs,
              revokingMs: end - firstRevocation,
            };
          }),
        );
        expect(counts).toMatchObject({
          grants: "10",
          settled: "0",
          cutOff: "8",
          unattempted: "2",
          revocationSpans: 8,
          warned: true,
        });
        expect(counts.purgeMs).toBeGreaterThanOrEqual(removalRevocationBudgetMs);
        expect(counts.revokingMs).toBeLessThanOrEqual(removalRevocationBudgetMs + 2_000);
      }),
    ),
  );
});
