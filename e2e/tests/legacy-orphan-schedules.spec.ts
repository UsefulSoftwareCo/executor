/** Orphan schedules left by older versions must not starve live schedules after an upgrade. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);
const source = `import { defineApp, mutation, userInterval, object, router } from "apps";
const record = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({}, async () => ({ tools: router({ record }), schedules: { record: userInterval({ minutes: 1 }, record, {}) } }));`;
// Two full dispatch batches: the scheduler scans eight due candidates, oldest first.
const orphans = 16;

layer(TestLive, { excludeTestServices: true })("Legacy schedule storage", (it) => {
  it.effect(scenarios.legacyOrphanSchedules.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const created = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Live schedule",
            files: [{ path: "index.ts", content: source }, appsManifest],
          },
          headers,
        );
        expect(created.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          created,
        );
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers)),
            Effect.orDie,
          ),
        );
        expect(
          (yield* session.send(
            "PATCH",
            `/v1/apps/${app.id}/schedules/record`,
            { actor: "local", enabled: true, approvalMode: "automatic" },
            headers,
          )).status,
        ).toBe(200);

        // Older versions kept schedules after deleting their app. No current surface can
        // create these rows, so write them as that version left them: enabled and long overdue.
        yield* legacyStorage([
          {
            sql: `INSERT INTO executor_schedules
              (id, app, installation, owner, name, actor, timing, enabled, approval_mode, next_at, active_run, revision)
              SELECT 'legacy-orphan-' || lpad(i::text, 2, '0'), 'app_legacy_missing_' || i, NULL,
                'local', 'record', 'local', '{"kind":"interval","milliseconds":60000}',
                true, 'automatic', TIMESTAMP '2000-01-01' + i * INTERVAL '1 second', NULL, 'legacy'
              FROM generate_series(0, $1::int - 1) AS i`,
            params: [orphans],
          },
        ]);
        // Cross the live schedule's first interval while stopped, then upgrade in place.
        yield* serverControl("clock/advance", 200, { milliseconds: 100_000 });
        yield* serverControl("start");

        const runs = session
          .send("GET", `/v1/scheduled-runs?app=${app.id}`, undefined, headers)
          .pipe(Effect.flatMap((response) => body(Runs, response)));
        const settled = yield* runs.pipe(
          Effect.repeat({
            until: (rows) => rows.some((row) => row.status === "succeeded"),
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeoutOption("20 seconds"),
        );
        const live = settled._tag === "Some" ? settled.value : yield* runs;
        expect(
          live.map(({ name, status }) => ({ name, status })),
          "live schedule ran",
        ).toEqual([{ name: "record", status: "succeeded" }]);

        const [stored, orphanRuns] = yield* legacyStorage([
          {
            sql: `SELECT id, enabled, next_at, active_run FROM executor_schedules
              WHERE app LIKE 'app_legacy_missing_%' ORDER BY id`,
          },
          {
            sql: `SELECT count(*)::int AS runs FROM executor_scheduled_runs
              WHERE app LIKE 'app_legacy_missing_%'`,
          },
        ]);
        expect(stored, "every orphan is paused").toEqual(
          Array.from({ length: orphans }, (_, i) => ({
            id: `legacy-orphan-${String(i).padStart(2, "0")}`,
            enabled: false,
            next_at: null,
            active_run: null,
          })),
        );
        expect(orphanRuns, "orphans never start runs").toEqual([{ runs: 0 }]);
      }),
    ),
  );
});
