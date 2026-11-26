import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { writeRows } from "../support/cloud-rows.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const SessionUser = Schema.Struct({
  user: Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{8,40}$/u)) }),
});

const Welcomes = Schema.Array(Schema.Struct({ user_id: Schema.String, status: Schema.String }));

const fireFiveMinuteCron = Effect.gen(function* () {
  const target = yield* Target;
  const http = yield* HttpClient.HttpClient;
  yield* Effect.scoped(
    http
      .get(
        `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`,
      )
      .pipe(Effect.flatMap((response) => response.text)),
  );
});

const dispatchTraces = (job: string) =>
  Effect.gen(function* () {
    const found = yield* (yield* Telemetry).searchWholeEnvironment("job.dispatch", {
      "executor.job": job,
    });
    return new Set(found.data.map((entry) => entry.traceId));
  });

const dispatched = (
  before: ReadonlySet<string>,
  job: string,
  outcome: "completed" | "partial" | "failed",
) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const found = yield* telemetry.searchWholeEnvironment("job.dispatch", {
      "executor.job": job,
      "executor.outcome": outcome,
    });
    const entry = found.data.find(({ traceId }) => !before.has(traceId));
    if (entry === undefined)
      return yield* Effect.fail(
        new Error(`No ${outcome} ${job} dispatch has reached the collector`),
      );
    const trace = yield* telemetry.query(entry.traceId);
    const dispatch = trace.data.find(
      ({ span }) => span.operationName === "job.dispatch" && span.tags["executor.job"] === job,
    );
    const route = trace.data.find(
      ({ span }) =>
        span.operationName.startsWith("http.server") &&
        span.tags["url.path"] === `/api/internal/jobs/${job}`,
    );
    return dispatch === undefined || route === undefined
      ? yield* Effect.fail(new Error("The dispatch and its job route have not both arrived"))
      : { trace, dispatch: dispatch.span, route: route.span };
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }));

layer(HostedLive, { excludeTestServices: true })("Cloud background job outcomes", (it) => {
  it.effect(scenarios.cloudJobOutcomes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const { user } = yield* body(
          SessionUser,
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        const fault = `"e2e_welcome_fault_${user.id}"`;

        yield* Effect.addFinalizer(() =>
          writeRows("sso-database.json", [
            { sql: `drop function if exists ${fault}() cascade` },
            {
              sql: `update cloud_welcome_email set status = 'sent', attempted_at = now(),
                sent_at = now() where user_id = $1`,
              params: [user.id],
            },
          ]).pipe(Effect.orDie),
        );
        yield* evidence.step(
          "Make the owner's welcome the oldest waiting, and refuse its claim",
          writeRows("sso-database.json", [
            {
              sql: `insert into cloud_welcome_email (user_id, created_at) values ($1, '2000-01-01Z')
                on conflict (user_id) do update set status = 'pending', attempted_at = null,
                  sent_at = null, created_at = excluded.created_at`,
              params: [user.id],
            },
            {
              sql: `create function ${fault}() returns trigger language plpgsql as $$
                begin raise exception 'Synthetic welcome email claim failure'; end $$`,
            },
            {
              sql: `create trigger ${fault} before update on cloud_welcome_email for each row
                when (old.user_id = '${user.id}' and new.status = 'attempting')
                execute function ${fault}()`,
            },
          ]),
        );

        const before = yield* Effect.all({
          "welcome-emails": dispatchTraces("welcome-emails"),
          "workflow-reconcile": dispatchTraces("workflow-reconcile"),
          "app-domain-heartbeat": dispatchTraces("app-domain-heartbeat"),
        });
        yield* fireFiveMinuteCron;

        const failed = yield* dispatched(before["welcome-emails"], "welcome-emails", "failed");
        yield* evidence.json("failed-welcome-dispatch.json", failed.trace);
        expect(failed.route.tags["http.response.status_code"]).toBe("204");
        expect(failed.route.status).not.toBe("error");
        expect(failed.dispatch).toMatchObject({
          status: "error",
          tags: {
            "http.response.status_code": "204",
            "executor.outcome": "failed",
            "executor.job.failure": "WelcomeEmailUnavailable",
          },
        });

        for (const job of ["workflow-reconcile", "app-domain-heartbeat"] as const) {
          const completed = yield* dispatched(before[job], job, "completed");
          expect(completed.route.tags["http.response.status_code"]).toBe("204");
          expect(completed.dispatch.status).not.toBe("error");
          expect(completed.dispatch.tags).toMatchObject({
            "http.response.status_code": "204",
            "executor.outcome": "completed",
          });
          expect(completed.dispatch.tags).not.toHaveProperty("executor.job.failure");
        }
      }),
    ),
  );

  it.effect(scenarios.cloudJobBatchOutcomes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const id = randomUUID().replaceAll("-", "");
        const refused = `e2e-refused-${id}`;
        const accepted = `e2e-accepted-${id}`;
        const gate = `"e2e_welcome_batch_${id}"`;
        const claimants = `"e2e_welcome_batch_claimants_${id}"`;

        yield* Effect.addFinalizer(() =>
          writeRows("sso-database.json", [
            { sql: `drop function if exists ${gate}() cascade` },
            { sql: `drop table if exists ${claimants}` },
            { sql: `delete from "user" where id in ($1, $2)`, params: [refused, accepted] },
          ]).pipe(Effect.orDie),
        );
        const beforeMixed = yield* dispatchTraces("welcome-emails");
        yield* evidence.step(
          "Add two recipients ahead of every waiting welcome, and let a run claim only them",
          writeRows("sso-database.json", [
            {
              sql: `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
                values ($1, 'Refused recipient', '', true, now(), now()),
                  ($2, 'Accepted recipient', $3, true, now(), now())`,
              params: [refused, accepted, `${accepted}@example.test`],
            },
            {
              sql: `delete from hosted_provisioning where user_id in ($1, $2)`,
              params: [refused, accepted],
            },
            {
              sql: `update cloud_welcome_email set created_at = case user_id
                  when $1 then timestamptz '2000-01-01 00:00:00Z'
                  else timestamptz '2000-01-01 00:00:01Z' end
                where user_id in ($1, $2)`,
              params: [refused, accepted],
            },
            { sql: `create table ${claimants} (pid integer not null)` },
            {
              sql: `create function ${gate}() returns trigger language plpgsql as $$
                begin
                  if old.user_id = '${refused}' then
                    insert into ${claimants} (pid) values (pg_backend_pid());
                    return new;
                  end if;
                  if old.user_id = '${accepted}'
                    and exists (select 1 from ${claimants} where pid = pg_backend_pid())
                    and not exists (select 1 from cloud_welcome_email
                      where user_id = '${refused}' and status in ('pending', 'attempting'))
                  then return new; end if;
                  return null;
                end $$`,
            },
            {
              sql: `create trigger ${gate} before update on cloud_welcome_email for each row
                when (new.status = 'attempting') execute function ${gate}()`,
            },
          ]),
        );
        const welcomes = writeRows("sso-database.json", [
          {
            sql: `select user_id, status from cloud_welcome_email where user_id in ($1, $2)
              order by created_at`,
            params: [refused, accepted],
          },
        ]).pipe(Effect.flatMap(([rows]) => Schema.decodeUnknownEffect(Welcomes)(rows)));

        yield* Effect.all([fireFiveMinuteCron, fireFiveMinuteCron], { concurrency: "unbounded" });
        const partial = yield* dispatched(beforeMixed, "welcome-emails", "partial");
        yield* evidence.json("partial-welcome-dispatch.json", partial.trace);
        expect(yield* welcomes).toEqual([
          { user_id: refused, status: "uncertain" },
          { user_id: accepted, status: "sent" },
        ]);
        expect(partial.route.tags["http.response.status_code"]).toBe("204");
        expect(partial.route.status).not.toBe("error");
        expect(partial.dispatch.status).not.toBe("error");
        expect(partial.dispatch.tags).toMatchObject({
          "http.response.status_code": "204",
          "executor.outcome": "partial",
          "executor.job.failure": "EmailDeliveryFailed",
        });

        const beforeRefused = yield* dispatchTraces("welcome-emails");
        yield* writeRows("sso-database.json", [
          {
            sql: `update cloud_welcome_email set status = 'pending', attempted_at = null
              where user_id = $1`,
            params: [refused],
          },
        ]);
        yield* fireFiveMinuteCron;
        const failed = yield* dispatched(beforeRefused, "welcome-emails", "failed");
        yield* evidence.json("failed-welcome-batch-dispatch.json", failed.trace);
        expect(yield* welcomes).toEqual([
          { user_id: refused, status: "uncertain" },
          { user_id: accepted, status: "sent" },
        ]);
        expect(failed.route.tags["http.response.status_code"]).toBe("204");
        expect(failed.route.status).not.toBe("error");
        expect(failed.dispatch).toMatchObject({
          status: "error",
          tags: {
            "http.response.status_code": "204",
            "executor.outcome": "failed",
            "executor.job.failure": "EmailDeliveryFailed",
          },
        });
      }),
    ),
  );
});
