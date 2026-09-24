/** Verify database correlation and wire timing delivered by real Cloud profile reads. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("SQL observability", (it) => {
  it.effect(scenarios.sqlTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}`;
        expect(actors.organization.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        const app = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `SQL telemetry ${randomUUID()}`,
            files: [
              {
                path: "index.ts",
                content:
                  'import { defineApp } from "apps"; export default defineApp({accounts:{}},{});',
              },
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        for (const [route, path] of [
          ["profiles", `${prefix}/apps/${app.id}/profiles`],
          ["inventory", `${prefix}/inventory`],
          ["resources", `${prefix}/resources`],
        ] as const) {
          const response = yield* api.request(actors.owner, "GET", path);
          expect(response.status).toBe(200);
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined) return yield* Effect.die(new Error("Missing HTTP evidence"));
          const delivered = yield* telemetry.query(request.traceId).pipe(
            Effect.flatMap((result) => {
              const sql = result.data.find(
                ({ span }) =>
                  span.operationName === "sql.execute" &&
                  span.tags["db.query.text"]?.includes('"executor_installations"'),
              );
              const wire = result.data.find(
                ({ span }) =>
                  span.operationName === "sql.wire" && span.parentSpanId === sql?.span.spanId,
              );
              return sql === undefined || wire === undefined
                ? Effect.fail(new Error("Profile SQL and its wire span must reach the collector"))
                : Effect.succeed({ sql, wire });
            }),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
            Effect.timeout("90 seconds"),
          );
          const { sql, wire } = delivered;
          expect(sql.traceId).toBe(request.traceId);
          expect(wire.traceId).toBe(request.traceId);
          expect(sql.span.tags["db.query.text"]?.slice(0, 1023)).toMatch(
            new RegExp(`^/\\*traceparent='00-${request.traceId}-${sql.span.spanId}-01'\\*/\\n`),
          );
          const tags = wire.span.tags;
          const dataAt = Number(tags["db.wire.first_data_ms"]);
          const first = Number(tags["db.wire.first_message_ms"]);
          expect(dataAt).toBeGreaterThanOrEqual(0);
          expect(first).toBeGreaterThanOrEqual(dataAt);
          expect(Number(tags["db.wire.first_data_bytes"])).toBeGreaterThan(0);
          expect(tags["db.wire.first_message_type"]).toBe("ParseComplete");
          expect(Number(tags["db.wire.write_callback_ms"])).toBeGreaterThanOrEqual(0);
          expect(Number(tags["db.wire.command_complete_ms"])).toBeGreaterThanOrEqual(first);
          expect(Number(tags["db.wire.ready_ms"])).toBeGreaterThanOrEqual(
            Number(tags["db.wire.command_complete_ms"]),
          );
          const startedAt = Number(tags["db.wire.started_at_ms"]);
          const readyAt = Number(tags["db.wire.ready_at_ms"]);
          expect(startedAt).toBeGreaterThan(0);
          expect(readyAt - startedAt).toBe(Number(tags["db.wire.ready_ms"]));
          expect(["pipelined", "parse-flush-bind"]).toContain(tags["db.wire.protocol_mode"]);
          if (tags["db.wire.protocol_mode"] === "parse-flush-bind") {
            const bindAt = Number(tags["db.wire.bind_sent_ms"]);
            expect(bindAt).toBeGreaterThanOrEqual(Number(tags["db.wire.parse_complete_ms"]));
            expect(Number(tags["db.wire.bind_write_callback_ms"])).toBeGreaterThanOrEqual(bindAt);
            expect(Number(tags["db.wire.bind_complete_ms"])).toBeGreaterThanOrEqual(bindAt);
            expect(Number(tags["db.wire.ready_ms"])).toBeGreaterThanOrEqual(bindAt);
          }
          yield* evidence.json(`${route}-sql-telemetry.json`, delivered);
        }
      }),
    ),
  );
});
