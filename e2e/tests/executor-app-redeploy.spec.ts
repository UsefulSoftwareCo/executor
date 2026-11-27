import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Committed, Workspace } from "../support/app-authoring.ts";
import { serverControl } from "../support/server-control.ts";
import { dataStepSummaries, nextDataStepSummary } from "../support/data-steps.ts";
import { declaredApps } from "../support/apps-release.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { Resource } from "../support/contracts.ts";
import { linkedAccountIds } from "../support/app-accounts.ts";

const step = "5_redeploy_pre_beta10_executor_apps";
const oldRelease = "0.0.1-beta.9";
const fixedRelease = "0.0.1-beta.10";
const targetRelease = "0.0.1-beta.84";
const frameworkPinRelease = "0.0.1-beta.2";
const token = "synthetic-redeploy-token";

type Files = readonly { readonly path: string; readonly content: string }[];
const source = (provider: string, release: string, marker: string): Files => [
  {
    path: "index.ts",
    content: `import { defineApp, object, query, router, string } from "apps";
import { service } from "./provider.ts";
// ${marker}
export default defineApp({ accounts: { service } }, {
  tools: router({
    token: query({ input: object({}), output: string() }, async (ctx) => ctx.accounts.service.fields.token),
  }),
});
`,
  },
  {
    path: "provider.ts",
    content: `import { defineProvider, object, secrets, string } from "apps";
export const service = defineProvider({ name: ${JSON.stringify(provider)}, auth: {
  apiKey: secrets({ label: "API key", fields: object({ token: string() }) }),
} });
`,
  },
  { path: "README.md", content: `Fixture ${marker}.\n` },
  {
    path: "package.json",
    content: JSON.stringify(
      { name: "executor", private: true, type: "module", dependencies: { apps: release } },
      null,
      2,
    ),
  },
];
const repinned = (files: Files, from: string, to: string): Files =>
  files.map((file) =>
    file.path === "package.json"
      ? { ...file, content: file.content.replace(`"apps": "${from}"`, `"apps": "${to}"`) }
      : file,
  );
const pinnedManifest = (files: Files, extra: Readonly<Record<string, string>> = {}): Files =>
  files.map((file) =>
    file.path === "package.json"
      ? {
          ...file,
          content: JSON.stringify(
            {
              private: true,
              type: "module",
              dependencies: { apps: frameworkPinRelease, ...extra },
            },
            null,
            2,
          ),
        }
      : file,
  );
const sorted = (files: Files) => files.toSorted((left, right) => (left.path < right.path ? -1 : 1));

const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  activeVersion: Schema.NullOr(Schema.String),
});
type App = typeof App.Type;
const Deployed = Schema.Struct({ app: App });
const RunningSource = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Metadata = Schema.Struct({ metadata: Schema.NullOr(Schema.String) });
const ExecutorDefaults = Schema.fromJsonString(
  Schema.Struct({
    executorDefaults: Schema.Struct({ app: Schema.String, deployment: Schema.String }),
  }),
);

layer(HostedLive, { excludeTestServices: true })("Executor app redeploy data step", (it) => {
  it.effect(
    scenarios.executorAppRedeploy.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors;
          const api = yield* Api;
          const target = yield* Target;
          const log = `${target.directory}/server.log`;
          const organization = actors.organization.id;
          const owner = `organization:${organization}`;
          const prefix = `/api/organizations/${organization}`;
          const request = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
            api.request(actors.owner, method, `${prefix}${path}`, data);
          const ok = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
            Effect.flatMap((response: { readonly status: number; readonly body: unknown }) => {
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return body(schema, response);
            });
          const created: App[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.forEach(created, (app) => request("DELETE", `/apps/${app.id}`)).pipe(
              Effect.ignore,
            ),
          );
          const deploy = (name: string, files: Files) =>
            request("POST", "/apps/deploy", {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files,
            }).pipe(
              ok(App),
              Effect.tap((app) => Effect.sync(() => created.push(app))),
            );
          const get = (app: App) => request("GET", `/apps/${app.id}`).pipe(ok(App));
          const workspace = (app: App) =>
            request("GET", `/apps/${app.id}/workspace`).pipe(ok(Workspace));
          const running = (app: App) =>
            request("GET", `/apps/${app.id}/source`).pipe(
              ok(RunningSource),
              Effect.map((result) => result.files),
            );
          const summaries = dataStepSummaries(log, step).pipe(Effect.map((all) => all.length));
          const nextSummary = <E, R>(start: Effect.Effect<void, E, R>) =>
            Effect.gen(function* () {
              const seen = yield* summaries;
              yield* start;
              return yield* nextDataStepSummary(log, step, seen);
            });

          expect(yield* nextDataStepSummary(log, step, 0)).toMatchObject({
            mode: "report",
            status: "complete",
          });

          const connect = (app: App) =>
            Effect.gen(function* () {
              const path = `${prefix}/apps/${app.id}`;
              const pending = yield* request(
                "POST",
                `/apps/${app.id}/accounts/user/service/connections`,
                {},
              ).pipe(ok(Resource));
              const account = (yield* request("POST", `/connections/${pending.id}/submit`, {
                method: "apiKey",
                label: "Synthetic",
                fields: { token },
              }).pipe(ok(Resource))).id;
              yield* Effect.addFinalizer(() =>
                request("DELETE", `/accounts/${account}`).pipe(Effect.ignore),
              );
              const call = request("POST", `/apps/${app.id}/tools/call`, {
                tool: "token",
                kind: "query",
                input: {},
              }).pipe(ok(Schema.String));
              const selected = linkedAccountIds(actors.owner, path);
              return { account, call, selected };
            });

          const untouchedFiles = source("Executor", oldRelease, "untouched");
          const untouched = yield* deploy("Executor untouched", untouchedFiles);
          const { account, call, selected } = yield* connect(untouched);
          expect(yield* call).toBe(token);

          const behind = yield* deploy("Executor behind", source("Executor", oldRelease, "first"));
          const behindFiles = source("Executor", oldRelease, "deployed");
          yield* request("POST", `/apps/${behind.id}/deploy`, { files: behindFiles }).pipe(
            ok(Deployed),
          );
          const pinnedFiles = source("Executor", oldRelease, "pinned");
          const pinned = yield* deploy("Executor pinned", pinnedFiles);
          yield* request("POST", `/apps/${pinned.id}/commits`, {
            expected: (yield* workspace(pinned)).revision.commit,
            files: pinnedManifest(pinnedFiles),
            message: `Pin the apps framework to ${frameworkPinRelease}`,
          }).pipe(ok(Committed));
          const pinnedEditedFiles = source("Executor", oldRelease, "pinned-edited");
          const pinnedEdited = yield* deploy("Executor pinned edited", pinnedEditedFiles);
          yield* request("POST", `/apps/${pinnedEdited.id}/commits`, {
            expected: (yield* workspace(pinnedEdited)).revision.commit,
            files: pinnedManifest(pinnedEditedFiles, { "left-pad": "1.3.0" }),
            message: "Add a dependency",
          }).pipe(ok(Committed));
          const behindPinnedFirst = source("Executor", oldRelease, "behind-pinned-first");
          const behindPinned = yield* deploy("Executor behind pinned", behindPinnedFirst);
          yield* request("POST", `/apps/${behindPinned.id}/commits`, {
            expected: (yield* workspace(behindPinned)).revision.commit,
            files: repinned(behindPinnedFirst, oldRelease, frameworkPinRelease),
            message: `Pin the apps framework to ${frameworkPinRelease}`,
          }).pipe(ok(Committed));
          const behindPinnedFiles = source("Executor", oldRelease, "behind-pinned-deployed");
          yield* request("POST", `/apps/${behindPinned.id}/deploy`, {
            files: behindPinnedFiles,
          }).pipe(ok(Deployed));
          const behindPinnedAccount = yield* connect(behindPinned);
          expect(yield* behindPinnedAccount.call).toBe(token);
          const behindEditedFirst = source("Executor", oldRelease, "behind-edited-first");
          const behindEdited = yield* deploy("Executor behind edited", behindEditedFirst);
          yield* request("POST", `/apps/${behindEdited.id}/commits`, {
            expected: (yield* workspace(behindEdited)).revision.commit,
            files: repinned(behindEditedFirst, oldRelease, frameworkPinRelease).map((file) =>
              file.path === "README.md" ? { ...file, content: "Edited.\n" } : file,
            ),
            message: "Edit the README",
          }).pipe(ok(Committed));
          yield* request("POST", `/apps/${behindEdited.id}/deploy`, {
            files: source("Executor", oldRelease, "behind-edited-deployed"),
          }).pipe(ok(Deployed));
          const edited = yield* deploy("Executor edited", source("Executor", oldRelease, "first"));
          yield* request("POST", `/apps/${edited.id}/commits`, {
            expected: (yield* workspace(edited)).revision.commit,
            files: source("Executor", oldRelease, "edited"),
            message: "Edit the app",
          }).pipe(ok(Committed));
          const fixed = yield* deploy("Executor fixed", source("Executor", fixedRelease, "fixed"));
          const other = yield* deploy("Other provider", source("Other", oldRelease, "other"));

          const apps = [
            untouched,
            behind,
            pinned,
            pinnedEdited,
            behindPinned,
            behindEdited,
            edited,
            fixed,
            other,
          ];
          const state = Effect.forEach(apps, (app) =>
            Effect.all({
              version: get(app).pipe(Effect.map((current) => current.activeVersion)),
              commit: workspace(app).pipe(Effect.map((current) => current.revision.commit)),
            }),
          );
          const before = yield* state;
          const executorApps = (yield* request("GET", "/apps").pipe(ok(Schema.Array(App)))).filter(
            (app) => app.name === "Executor",
          ).length;

          const report = yield* nextSummary(serverControl("restart"));
          expect(report).toMatchObject({ mode: "report", status: "complete", pass: 1 });
          expect(report.owners[owner]).toEqual({
            redeploy: 1,
            "redeploy-behind": 1,
            "redeploy-pinned": 1,
            "redeploy-behind-pinned": 1,
            edited: 3,
            current: 1 + executorApps,
          });
          expect(yield* state).toEqual(before);

          const recordedBefore = yield* legacyStorage([
            { sql: `SELECT metadata FROM "organization" WHERE id = $1`, params: [organization] },
            {
              sql: `UPDATE "organization" SET metadata = jsonb_set(coalesce(metadata::jsonb, '{}'::jsonb), '{executorDefaults}', jsonb_build_object('installed', true, 'app', $2::text, 'deployment', $3::text))::text WHERE id = $1`,
              params: [organization, untouched.id, before[0]?.version ?? null],
            },
          ]);
          const metadata = (yield* Schema.decodeUnknownEffect(Metadata)(recordedBefore[0]?.[0]))
            .metadata;
          yield* serverControl("data-steps", 200, { mode: "apply" });
          const applied = yield* nextSummary(serverControl("start"));
          expect(applied).toMatchObject({
            mode: "apply",
            run: "apply",
            status: "complete",
            pass: 1,
          });
          expect(applied.owners[owner]).toEqual({
            redeployed: 1,
            "redeployed-behind": 1,
            "redeployed-pinned": 1,
            "redeployed-behind-pinned": 1,
            edited: 3,
            current: 1 + executorApps,
          });
          const recordedAfter = yield* legacyStorage([
            { sql: `SELECT metadata FROM "organization" WHERE id = $1`, params: [organization] },
            {
              sql: `UPDATE "organization" SET metadata = $2 WHERE id = $1`,
              params: [organization, metadata],
            },
          ]);
          yield* serverControl("start");
          const defaults = yield* Schema.decodeUnknownEffect(Metadata)(recordedAfter[0]?.[0]).pipe(
            Effect.flatMap((row) =>
              Schema.decodeUnknownEffect(ExecutorDefaults)(row.metadata ?? ""),
            ),
          );

          const redeployed = yield* get(untouched);
          expect(redeployed.id).toBe(untouched.id);
          expect(redeployed.activeVersion).not.toBe(before[0]?.version);
          expect(defaults.executorDefaults).toEqual({
            app: untouched.id,
            deployment: redeployed.activeVersion,
          });
          const expected = sorted(repinned(untouchedFiles, oldRelease, targetRelease));
          expect(sorted(yield* running(untouched))).toEqual(expected);
          expect(declaredApps(yield* running(untouched))).toBe(targetRelease);
          expect(sorted((yield* workspace(untouched)).files)).toEqual(expected);
          expect(yield* call).toBe(token);
          expect(yield* selected).toEqual([account]);

          const behindExpected = sorted(repinned(behindFiles, oldRelease, targetRelease));
          expect(sorted(yield* running(behind))).toEqual(behindExpected);
          expect(sorted((yield* workspace(behind)).files)).toEqual(behindExpected);

          const pinnedExpected = sorted(repinned(pinnedFiles, oldRelease, targetRelease));
          expect(sorted(yield* running(pinned))).toEqual(pinnedExpected);
          expect(sorted((yield* workspace(pinned)).files)).toEqual(pinnedExpected);

          const behindPinnedExpected = sorted(
            repinned(behindPinnedFiles, oldRelease, targetRelease),
          );
          expect(sorted(yield* running(behindPinned))).toEqual(behindPinnedExpected);
          expect(sorted((yield* workspace(behindPinned)).files)).toEqual(behindPinnedExpected);
          expect(yield* behindPinnedAccount.call).toBe(token);
          expect(yield* behindPinnedAccount.selected).toEqual([behindPinnedAccount.account]);

          const after = yield* state;
          for (const app of [pinnedEdited, behindEdited, edited, fixed, other])
            expect(after[apps.indexOf(app)], app.name).toEqual(before[apps.indexOf(app)]);
          expect(declaredApps(yield* running(other))).toBe(oldRelease);

          const quiet = yield* summaries;
          yield* serverControl("restart");
          expect(yield* summaries).toBe(quiet);
          expect(yield* state).toEqual(after);
        }),
      ),
    { timeout: 180_000 },
  );
});
