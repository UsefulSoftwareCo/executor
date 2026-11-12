/**
 * A platform admin impersonates a user through the shared dev widget and returns. Each start and
 * stop leaves a `security.audit` record naming the admin as the actor and the user as the target,
 * and everything done in the impersonation session names the admin as `auth.impersonated_by`,
 * including requests in an app session signed in from it. `/api/viewer` never names the admin.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { fixtureRequest } from "../sdk/fixtures.ts";
import { scenarios } from "../test-plan.ts";

const Identity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
  session: Schema.Struct({ impersonatedBy: Schema.optional(Schema.NullOr(Schema.String)) }),
});
const LogRecords = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        body: Schema.String,
        attributes: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);
const auditKeys = [
  "audit.outcome",
  "audit.failure",
  "audit.target.kind",
  "audit.target.id",
  "executor.user.id",
  "auth.impersonated_by",
] as const;
const traced = () => {
  const traceId = randomBytes(16).toString("hex");
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
};

layer(HostedLive, { excludeTestServices: true })("Cloud impersonation", (it) => {
  it.effect(scenarios.cloudImpersonation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target;
        /** The trace's one `security.audit` record for `action`, once it is delivered. */
        const audit = (traceId: string, action: string) =>
          telemetry.logs(traceId).pipe(
            Effect.tap((logs) => evidence.json(`audit-${action}-${traceId}.json`, logs)),
            Effect.map((logs) =>
              Schema.decodeUnknownSync(LogRecords)(logs).data.filter(
                (record) =>
                  record.body === "security.audit" && record.attributes["audit.action"] === action,
              ),
            ),
            Effect.filterOrFail(
              (records) => records.length > 0,
              () => new Error(`The ${action} record has not reached the collector`),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            Effect.map((records) => {
              expect(records, `one ${action} record`).toHaveLength(1);
              return Object.fromEntries(auditKeys.map((key) => [key, records[0]?.attributes[key]]));
            }),
          );
        /** The trace's request spans that `keep` selects, once they are delivered. */
        const serverSpans = (
          traceId: string,
          keep: (tags: Readonly<Record<string, unknown>>) => boolean = () => true,
        ) =>
          telemetry.query(traceId).pipe(
            Effect.map((result) =>
              result.data
                .map(({ span }) => span)
                .filter((span) => span.operationName.startsWith("http.server ") && keep(span.tags)),
            ),
            Effect.filterOrFail(
              (spans) => spans.length > 0,
              () => new Error("The request span has not reached the collector"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
        const identity = (session: typeof actors.owner) =>
          api
            .request(session, "GET", "/api/auth/get-session")
            .pipe(Effect.flatMap((response) => body(Identity, response)));
        const owner = yield* identity(actors.owner),
          member = yield* identity(actors.member);
        const anonymous = yield* api.session();
        for (const session of [anonymous, actors.owner, actors.admin, actors.member]) {
          expect(
            (yield* api.request(session, "GET", "/api/auth/admin/list-users")).status,
          ).toBeGreaterThanOrEqual(400);
          expect(
            (yield* api.request(session, "POST", "/api/auth/admin/impersonate-user", {
              userId: member.user.id,
            })).status,
          ).toBeGreaterThanOrEqual(400);
        }
        yield* browser.login(actors.admin);
        yield* browser.use("Open the ordinary organization admin dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Wait for the organization admin dashboard", (page) =>
          page.getByRole("heading", { name: /^Apps\s*\d+$/ }).waitFor(),
        );
        expect(
          yield* browser.use("Organization admins have no authenticated user picker", (page) =>
            page.getByRole("textbox", { name: "Search users by email", exact: true }).count(),
          ),
        ).toBe(0);
        if (!target.fixtures || !target.scenarioId)
          return yield* Effect.die("Missing owned fixture control");
        yield* fixtureRequest(target.fixtures, "/operator", { id: target.scenarioId });
        expect((yield* api.request(actors.owner, "GET", "/api/auth/admin/list-users")).status).toBe(
          200,
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the platform admin dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Open the shared Executor widget", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).click(),
        );
        yield* browser.use("Find the target by email", (page) =>
          page
            .getByRole("textbox", { name: "Search users by email", exact: true })
            .fill(member.user.email),
        );
        yield* browser.use("Submit the directory search", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("Wait for the target user", (page) =>
          page
            .getByRole("button", { name: `Impersonate ${member.user.email}`, exact: true })
            .waitFor(),
        );
        yield* browser.checkpoint("Platform admin user search in the shared dev widget");
        yield* browser.use("Impersonate the member", (page) =>
          page
            .getByRole("button", { name: `Impersonate ${member.user.email}`, exact: true })
            .click(),
        );
        yield* browser.use("Return control stays visible", (page) =>
          page.getByRole("button", { name: "Return to my account", exact: true }).waitFor(),
        );
        const switched = yield* browser.use("Read the active identity", (page) =>
          page.request
            .get("/api/auth/get-session")
            .then((response) => response.json())
            .then(Schema.decodeUnknownSync(Identity)),
        );
        expect(switched.user.id).toBe(member.user.id);
        expect(switched.session.impersonatedBy).toBe(owner.user.id);
        expect(
          yield* browser.use("The member cannot list all users", (page) =>
            page.request.get("/api/auth/admin/list-users").then((response) => response.status()),
          ),
        ).toBe(403);
        yield* browser.checkpoint("Persistent impersonation status and return control");
        yield* browser.use("Return to the original admin", (page) =>
          page.getByRole("button", { name: "Return to my account", exact: true }).click(),
        );
        yield* browser.use("The normal widget returns", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).waitFor(),
        );
        const restored = yield* browser.use("Verify the restored identity", (page) =>
          page.request
            .get("/api/auth/get-session")
            .then((response) => response.json())
            .then(Schema.decodeUnknownSync(Identity)),
        );
        expect(restored.user.id).toBe(owner.user.id);
        expect(restored.session.impersonatedBy == null).toBe(true);
        expect(
          yield* browser.use("Platform access is restored", (page) =>
            page.request.get("/api/auth/admin/list-users").then((response) => response.status()),
          ),
        ).toBe(200);

        yield* evidence.step(
          "Impersonation is audited as the admin's action on the user, and its session names the admin",
          Effect.gen(function* () {
            const refusal = traced();
            expect(
              (yield* api.request(
                actors.member,
                "POST",
                "/api/auth/admin/impersonate-user",
                { userId: owner.user.id },
                { traceparent: refusal.traceparent },
              )).status,
            ).toBe(403);
            const refused = yield* audit(refusal.traceId, "impersonation.start");
            expect(
              [refused["audit.outcome"], refused["audit.failure"], refused["audit.target.id"]],
              "A refused impersonation names Better Auth's code and no target",
            ).toEqual(["failure", "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS", undefined]);

            const operator = yield* freshOwnerSession;
            const start = traced();
            const started = yield* api.request(
              operator,
              "POST",
              "/api/auth/admin/impersonate-user",
              { userId: member.user.id },
              { traceparent: start.traceparent },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            expect(
              yield* audit(start.traceId, "impersonation.start"),
              "The start names the admin as the actor and the user as the target",
            ).toEqual({
              "audit.outcome": "success",
              "audit.failure": undefined,
              "audit.target.kind": "user",
              "audit.target.id": member.user.id,
              "executor.user.id": owner.user.id,
              "auth.impersonated_by": undefined,
            });

            const read = traced();
            expect(
              (yield* api.request(
                operator,
                "GET",
                `/api/organizations/${actors.organization.slug}/access`,
                undefined,
                { traceparent: read.traceparent },
              )).status,
            ).toBe(200);
            const served = yield* serverSpans(read.traceId);
            expect(
              served.map((span) => [
                span.tags["executor.user.id"],
                span.tags["auth.impersonated_by"],
              ]),
              "A request in the impersonation session names the user and the admin",
            ).toEqual([[member.user.id, owner.user.id]]);

            const create = traced();
            const created = yield* api.request(
              operator,
              "POST",
              "/api/auth/api-key/create",
              { name: "Created while impersonated" },
              { traceparent: create.traceparent },
            );
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const key = yield* body(Schema.Struct({ id: Schema.String }), created);
            expect(
              yield* audit(create.traceId, "api_key.create"),
              "So does an audited action in it",
            ).toEqual({
              "audit.outcome": "success",
              "audit.failure": undefined,
              "audit.target.kind": "api_key",
              "audit.target.id": key.id,
              "executor.user.id": member.user.id,
              "auth.impersonated_by": owner.user.id,
            });

            const viewer = yield* api.request(operator, "GET", "/api/viewer");
            expect(viewer.status).toBe(200);
            expect(
              viewer.body,
              "/api/viewer returns the impersonated user and only its own fields, never the admin",
            ).toEqual({
              userId: member.user.id,
              sessionId: expect.any(String),
              name: expect.any(String),
            });

            // A shared app opened from the impersonation session gets an app session whose
            // requests name the impersonated user and the admin.
            const prefix = `/api/organizations/${actors.organization.id}`;
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Impersonated app ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
                },
                { path: "ui/index.html", content: "<!doctype html><h1>Impersonated app</h1>" },
                appsManifest,
              ],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const access = yield* body(
              Schema.Struct({ revision: Schema.String }),
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);
            const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
            yield* browser.login(operator);
            yield* openPrivateApp(url);
            const page = traced();
            expect(
              yield* browser.use(
                "Request the app page in the impersonated app session",
                (current) =>
                  current.request
                    .get(url, { headers: { traceparent: page.traceparent } })
                    .then((response) => response.status()),
              ),
            ).toBe(200);
            const appSpans = yield* serverSpans(
              page.traceId,
              (tags) => tags["auth.credential.kind"] === "app_session",
            );
            expect(
              appSpans.map((span) => [
                span.tags["executor.user.id"],
                span.tags["auth.impersonated_by"],
              ]),
              "An app session request names the impersonated user and the admin",
            ).toEqual([[member.user.id, owner.user.id]]);

            const stop = traced();
            const stopped = yield* api.request(
              operator,
              "POST",
              "/api/auth/admin/stop-impersonating",
              {},
              { traceparent: stop.traceparent },
            );
            expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
            const ended = yield* audit(stop.traceId, "impersonation.stop");
            expect(
              [
                ended["audit.outcome"],
                ended["audit.target.kind"],
                ended["audit.target.id"],
                ended["executor.user.id"],
              ],
              "The stop names the admin as the actor and the user as the target",
            ).toEqual(["success", "user", member.user.id, owner.user.id]);
          }),
        );
      }),
    ),
  );
});
