/**
 * The hosted management API's request span names the organization it serves and the caller by
 * their opaque IDs, so one organization's failures can be told apart from another's and the users
 * they reach counted. A route names its organization by slug or ID, and any signed-in caller can
 * send one, so the span names an organization only once it is the caller's own: a signed-in
 * session's once its membership there holds, a bearer's once its check knows the grant's or key's
 * organization. A request refused after that, such as for an icon the organization does not have,
 * keeps both. A request refused for an organization the caller never joined (only Cloud lets a
 * user hold several) or one it left never names that organization, so it cannot count against it.
 * It still names its verified caller, the kind of credential (`auth.credential.kind`) and why it
 * was refused (`auth.failure.reason`), so refusals can be attributed to who made them. A batched
 * dashboard read's span (`dashboard.batch.read`) follows the same rules, and a bearer's check
 * (`auth.authenticate`) names only its own organization and user.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const SessionIdentity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
});
const BatchAnswer = Schema.Struct({ id: Schema.Number, status: Schema.Number });
const organizationId = "executor.organization.id";
const userId = "executor.user.id";
const accessRoute = "/api/organizations/:organization/access";
const iconRoute = "/api/organizations/:organization/icons/:key";

layer(HostedLive, { excludeTestServices: true })("Organization request spans", (it) => {
  it.effect(
    scenarios.organizationRequestSpans.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            evidence = yield* Evidence,
            oauth = yield* McpOAuth,
            telemetry = yield* Telemetry,
            target = yield* Target;
          const organization = actors.organization;
          const identity = (actor: Session) =>
            api
              .request(actor, "GET", "/api/auth/get-session")
              .pipe(Effect.flatMap((response) => body(SessionIdentity, response)));
          const traced = () => {
            const traceId = randomBytes(16).toString("hex");
            return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
          };
          /** A trace's delivered spans, once `ready` holds for them. */
          const delivered = (
            label: string,
            traceId: string,
            ready: (spans: ReadonlyArray<Span>) => boolean,
          ) =>
            telemetry.query(traceId).pipe(
              Effect.map((result) => result.data.map(({ span }) => span)),
              Effect.flatMap((spans) =>
                ready(spans)
                  ? Effect.succeed(spans)
                  : Effect.fail(new Error("The request's spans have not reached the collector")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.tap((spans) => evidence.json(`${label}.json`, spans)),
            );
          const names = (span: Span) => [span.tags[organizationId], span.tags[userId]];
          /** A request span's organization, user, credential kind and refusal reason. */
          const requestNames = (span: Span) => [
            ...names(span),
            span.tags["auth.credential.kind"],
            span.tags["auth.failure.reason"],
          ];
          /**
           * `GET path` (whose route is `route`) as `actor`'s session or with `credential`, the status
           * and the organization and user its delivered request span records, and for a bearer the
           * status, organization and user its check (`auth.authenticate`) records.
           */
          const request = (
            label: string,
            actor: Session,
            path: string,
            route: string,
            credential?: Redacted.Redacted<string>,
          ) =>
            Effect.gen(function* () {
              const { traceId, traceparent } = traced();
              const response = yield* api.request(actor, "GET", path, undefined, {
                traceparent,
                ...(credential === undefined
                  ? {}
                  : { authorization: `Bearer ${Redacted.value(credential)}` }),
              });
              const served = (span: Span) =>
                span.operationName.startsWith("http.server ") && span.tags["http.route"] === route;
              const checked = (span: Span) => span.operationName === "auth.authenticate";
              const spans = yield* delivered(
                label,
                traceId,
                (all) => all.some(served) && (credential === undefined || all.some(checked)),
              );
              return {
                status: response.status,
                spans: spans
                  .filter(served)
                  .map((span) => [span.tags["http.response.status_code"], ...requestNames(span)]),
                checks: spans.filter(checked).map((span) => [span.status, ...names(span)]),
              };
            });
          const access = (
            label: string,
            actor: Session,
            reference: string,
            credential?: Redacted.Redacted<string>,
          ) =>
            request(
              label,
              actor,
              `/api/organizations/${reference}/access`,
              accessRoute,
              credential,
            );
          /** `GET /access` of `reference` as one batched dashboard read of `actor`'s session. */
          const batched = (label: string, actor: Session, reference: string) =>
            Effect.gen(function* () {
              const { traceId, traceparent } = traced();
              const response = yield* api.request(actor, "POST", "/api/dashboard/batch", {
                reads: [
                  {
                    id: 0,
                    group: "organization",
                    endpoint: "access",
                    params: { organization: reference },
                    query: {},
                    traceparent,
                  },
                ],
              });
              expect(response.status, "The batch itself is answered").toBe(200);
              const answer = yield* body(BatchAnswer, response);
              const read = (span: Span) => span.operationName === "dashboard.batch.read";
              const spans = yield* delivered(label, traceId, (all) => all.some(read));
              return {
                status: answer.status,
                spans: spans
                  .filter(read)
                  .map((span) => [span.tags["http.response.status_code"], ...requestNames(span)]),
              };
            });
          const created = yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
            name: "Organization request spans",
          });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const key = yield* body(Key, created);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.ignore),
          );
          const member = (yield* identity(actors.member)).user;
          const owner = (yield* identity(actors.owner)).user;

          yield* evidence.step(
            "A member's request names their organization and them by ID, a refused one included",
            Effect.gen(function* () {
              expect(
                yield* access("member", actors.member, organization.slug),
                "The route names the organization by slug; the span names its ID and the session's user",
              ).toEqual({
                status: 200,
                spans: [["200", organization.id, member.id, "session", undefined]],
                checks: [],
              });
              expect(
                yield* access("member-key", actors.member, organization.slug, key.key),
                "So does a request with the member's API key, and its check names the key's user",
              ).toEqual({
                status: 200,
                spans: [["200", organization.id, member.id, "api_key", undefined]],
                checks: [["ok", organization.id, member.id]],
              });
              expect(
                yield* batched("member-batch", actors.member, organization.slug),
                "So does a batched dashboard read",
              ).toEqual({
                status: 200,
                spans: [["200", organization.id, member.id, "session", undefined]],
              });
              // The organization has no icon under this key, so the request is refused after its
              // membership holds.
              const icon = `/api/organizations/${organization.slug}/icons/${randomBytes(32).toString("hex")}`;
              expect(
                yield* request("member-icon", actors.member, icon, iconRoute),
                "A request refused in the caller's own organization names both",
              ).toEqual({
                status: 404,
                spans: [["404", organization.id, member.id, "session", undefined]],
                checks: [],
              });
            }),
          );

          yield* browser.login(actors.owner);
          const grant = yield* evidence.step(
            "Authorize an API grant in the browser",
            oauth.authorizeApi,
          );
          const grantToken = Redacted.make(Redacted.value(grant.tokens).access_token);
          yield* evidence.step(
            "An OAuth grant's request names the grant's user",
            Effect.gen(function* () {
              expect(
                yield* access("owner-grant", actors.owner, organization.slug, grantToken),
              ).toEqual({
                status: 200,
                spans: [["200", organization.id, owner.id, "oauth_access_token", undefined]],
                checks: [["ok", organization.id, owner.id]],
              });
            }),
          );

          if (target.metadata.target === "cloud")
            yield* evidence.step(
              "A request for an organization the caller never joined names its caller, not it",
              Effect.gen(function* () {
                const response = yield* api.request(
                  actors.owner,
                  "POST",
                  "/api/auth/organization/create",
                  {
                    name: "Organization request spans, another",
                    slug: `organization-request-spans-${randomUUID().slice(0, 8)}`,
                    keepCurrentActiveOrganization: true,
                  },
                );
                expect(response.status, JSON.stringify(response.body)).toBe(200);
                const other = yield* body(Organization, response);
                yield* Effect.addFinalizer(() =>
                  api
                    .request(actors.owner, "DELETE", `/api/organizations/${other.id}`)
                    .pipe(Effect.ignore),
                );
                expect(
                  yield* access("owner-other", actors.owner, other.slug),
                  "Its own member's request names it and them",
                ).toEqual({
                  status: 200,
                  spans: [["200", other.id, owner.id, "session", undefined]],
                  checks: [],
                });
                expect(
                  yield* access("member-other", actors.member, other.slug),
                  "A signed-in session refused for it names its user and why, not the organization",
                ).toEqual({
                  status: 403,
                  spans: [["403", undefined, member.id, "session", "not_member"]],
                  checks: [],
                });
                expect(
                  yield* access("member-key-other", actors.member, other.slug, key.key),
                  "So does an API key refused for it; its check names neither",
                ).toEqual({
                  status: 403,
                  spans: [["403", undefined, member.id, "api_key", "not_member"]],
                  checks: [["error", undefined, undefined]],
                });
                expect(
                  yield* batched("member-batch-other", actors.member, other.slug),
                  "So does a batched read refused for it",
                ).toEqual({
                  status: 403,
                  spans: [["403", undefined, member.id, "session", "not_member"]],
                });
                expect(
                  yield* access("owner-grant-other", actors.owner, other.slug, grantToken),
                  "A grant used for another organization names only the grant's own, on the request and its check",
                ).toEqual({
                  status: 403,
                  spans: [
                    [
                      "403",
                      organization.id,
                      owner.id,
                      "oauth_access_token",
                      "organization_mismatch",
                    ],
                  ],
                  checks: [["error", organization.id, owner.id]],
                });
              }),
            );

          // On both products the member then leaves the organization. Its session and its key
          // outlive the membership.
          yield* evidence.step(
            "A request for an organization the caller left names its caller, not it",
            Effect.gen(function* () {
              const removed = yield* api.request(
                actors.owner,
                "POST",
                "/api/auth/organization/remove-member",
                { organizationId: organization.id, memberIdOrEmail: member.email },
              );
              expect(removed.status, JSON.stringify(removed.body)).toBe(200);
              expect(
                yield* access("member-left", actors.member, organization.slug),
                "A signed-in session refused for it names its user and why, not the organization",
              ).toEqual({
                status: 403,
                spans: [["403", undefined, member.id, "session", "not_member"]],
                checks: [],
              });
              expect(
                yield* access("member-key-left", actors.member, organization.slug, key.key),
                "So does an API key refused for it; its check names neither",
              ).toEqual({
                status: 403,
                spans: [["403", undefined, member.id, "api_key", "not_member"]],
                checks: [["error", undefined, undefined]],
              });
              expect(
                yield* batched("member-batch-left", actors.member, organization.slug),
                "So does a batched read refused for it",
              ).toEqual({
                status: 403,
                spans: [["403", undefined, member.id, "session", "not_member"]],
              });
            }),
          );
        }).pipe(Effect.provide(McpOAuth.layer)),
      ),
    { timeout: 180_000 },
  );
});
