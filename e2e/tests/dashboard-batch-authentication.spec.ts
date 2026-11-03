import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { batchPath, type BatchedRead } from "../support/read-batches.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String });
const Answer = Schema.Struct({
  id: Schema.Int,
  status: Schema.Int,
  text: Schema.optional(Schema.String),
});
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(Answer));

/** Read the public batch stream with an actor's cookie jar, without opening a dashboard page. */
const send = (session: Session, reads: ReadonlyArray<BatchedRead>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const origin = targetHosts(yield* Target).browser;
      const cookies = Redacted.value(yield* session.cookies);
      const traceId = randomUUID().replaceAll("-", "");
      const request = yield* HttpClientRequest.post(new URL(batchPath, origin)).pipe(
        HttpClientRequest.setHeaders({
          origin,
          cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
          "executor-wire-revision": "1",
        }),
        HttpClientRequest.bodyJson({
          reads: reads.map((read) => ({
            ...read,
            traceparent: `00-${traceId}-${traceId.slice(0, 16)}-01`,
          })),
        }),
      );
      const started = yield* Clock.currentTimeMillis;
      const response = yield* client.execute(request);
      const text = yield* response.text;
      const ms = (yield* Clock.currentTimeMillis) - started;
      expect(response.status).toBe(200);
      const answers = yield* Effect.forEach(text.trim().split("\n"), (line) => decodeAnswer(line));
      return { traceId, ms, answers: answers.sort((left, right) => left.id - right.id) };
    }),
  );

/** Wait for all reads to be delivered before counting the batch's actual authentication spans. */
const authentication = (traceId: string, reads: number) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const evidence = yield* Evidence;
    let operations: Record<string, number> = {};
    return yield* telemetry.query(traceId).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          operations = {};
          for (const { span } of result.data)
            operations[span.operationName] = (operations[span.operationName] ?? 0) + 1;
        }),
      ),
      Effect.flatMap((result) =>
        result.data.filter(({ span }) => span.operationName === "dashboard.batch.read").length ===
        reads
          ? Effect.succeed(result.data)
          : Effect.fail(new Error("The completed batch trace must reach Motel")),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
      Effect.timeout("25 seconds"),
      Effect.tapError(() => evidence.json("batch-trace-counts.json", { reads, operations })),
      Effect.map((spans) => ({
        sessions: spans.filter(({ span }) => span.operationName === "auth.current").length,
        organizations: spans.filter(({ span }) => span.operationName === "auth.organization")
          .length,
        memberships: spans.filter(({ span }) => span.operationName === "auth.membership").length,
        removals: spans.filter(
          ({ span }) =>
            span.operationName === "sql.execute" &&
            String(span.tags["db.query.text"] ?? "").includes("from hosted_organization_removal"),
        ).length,
      })),
    );
  });

layer(HostedLive, { excludeTestServices: true })("Dashboard batch authentication", (it) => {
  it.effect(scenarios.dashboardBatchAuthentication.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const evidence = yield* Evidence;
        const cloud = (yield* Target).metadata.target === "cloud";
        const expected = {
          sessions: 1,
          organizations: cloud ? 1 : 0,
          memberships: 1,
          removals: cloud ? 1 : 0,
        };
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Batch authentication",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({ hello: query({ description: "Greeting", input: object({}) }, async () => "Hello") }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const read = (group: string, endpoint: string, params: Record<string, string> = {}) => ({
          id: 0,
          group,
          endpoint,
          params,
          query: {},
        });
        const batch = (reads: ReadonlyArray<BatchedRead>) =>
          reads.map((read, id) => ({ ...read, id }));
        const page = batch([
          read("viewer", "get"),
          read("organization", "access", { organization }),
          read("organization", "inventory", { organization }),
          read("apps", "get", { organization, app: app.id }),
          read("appAccounts", "appList", { organization, app: app.id }),
          read("appAccounts", "userList", { organization, app: app.id }),
          read("resourceAccess", "app", { organization, app: app.id }),
          read("tools", "index", { organization, app: app.id }),
        ]);
        const first = yield* send(actors.owner, page);
        expect(first.answers.map(({ status }) => status)).toEqual(page.map(() => 200));
        const firstChecks = yield* authentication(first.traceId, page.length);

        const samples: Array<number> = [];
        let last = first;
        for (let index = 0; index < 30; index++) {
          last = yield* send(actors.owner, page);
          expect(last.answers.map(({ status }) => status)).toEqual(page.map(() => 200));
          samples.push(last.ms);
        }
        const lastChecks = yield* authentication(last.traceId, page.length);
        samples.sort((left, right) => left - right);
        yield* evidence.json("batch-profile.json", {
          reads: page.length,
          samples: samples.length,
          p50Ms: samples[Math.ceil(samples.length * 0.5) - 1],
          p90Ms: samples[Math.ceil(samples.length * 0.9) - 1],
          firstChecks,
          lastChecks,
        });
        expect(firstChecks, "Dashboard batch authentication budget").toEqual(expected);
        expect(lastChecks, "Dashboard batch authentication budget").toEqual(expected);

        // Aliases share a membership check; another reference must never inherit that access.
        const mixed = yield* send(
          actors.owner,
          batch([
            read("organization", "access", { organization }),
            read("organization", "access", { organization: actors.organization.slug }),
            read("organization", "access", { organization: `missing-${randomUUID()}` }),
          ]),
        );
        expect(mixed.answers.map(({ status }) => status)).toEqual([200, 200, 403]);
        expect(yield* authentication(mixed.traceId, 3)).toEqual({
          ...expected,
          organizations: cloud ? 3 : 0,
        });

        const identity = batch([
          read("viewer", "get"),
          read("organization", "access", { organization }),
        ]);
        const member = yield* send(actors.member, identity);
        expect(member.answers.map(({ status }) => status)).toEqual([200, 200]);
        expect(JSON.parse(member.answers[1]?.text ?? "null")).toMatchObject({ role: "member" });
        const signedIn = yield* body(
          Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }),
          yield* api.request(actors.member, "GET", "/api/auth/get-session"),
        );
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: organization,
            memberIdOrEmail: signedIn.user.email,
          })).status,
        ).toBe(200);
        const removed = yield* send(actors.member, identity);
        expect(removed.answers.map(({ status }) => status)).toEqual([200, 403]);

        const fresh = yield* freshOwnerSession;
        expect((yield* send(fresh, identity)).answers.map(({ status }) => status)).toEqual([
          200, 200,
        ]);
        expect((yield* api.request(fresh, "POST", "/api/auth/sign-out", {})).status).toBe(200);
        const revoked = yield* send(fresh, identity);
        expect(revoked.answers.map(({ status }) => status)).toEqual([401, 401]);
      }),
    ),
  );
});
