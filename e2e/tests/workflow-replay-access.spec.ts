/** Retained workflow output keeps its account authorization after the caller's links change. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectionsPath, linkAccount, unlinkAccount } from "../support/app-accounts.ts";
import { WorkflowRun } from "../support/workflow-app.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Access = Schema.Struct({ revision: Schema.String });
const source = `import { defineApp, defineProvider, secrets, workflow, object, string } from "apps";
const service = defineProvider({ name: "Replay access fixture", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
const capture = workflow({ input: object({ label: string() }) }, async (ctx, input) =>
  ctx.step.do("capture", async step => ({ label: input.label, account: step.user.accounts.service.id,
    value: step.user.accounts.service.fields.token, execution: crypto.randomUUID() })));
export default defineApp({ user: { accounts: { service } } }, { workflows: { capture } });`;

layer(HostedLive, { excludeTestServices: true })("Workflow replay access", (it) => {
  it.effect(scenarios.workflowReplayAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Replay access ${randomUUID()}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Resource, deployed);
        const path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
            for (const account of accounts)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
          }).pipe(Effect.orDie),
        );
        const appAccess = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: appAccess.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const connect = (token: string) =>
          Effect.gen(function* () {
            const pending = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(path, "user", "service"),
              { destination: { kind: "shared", audience: { kind: "everyone" } } },
            );
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const connection = yield* body(Resource, pending);
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              {
                method: "key",
                label: token,
                fields: { token },
              },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const account = yield* body(Resource, response);
            accounts.push(account.id);
            return account.id;
          });
        const original = yield* connect("synthetic-original");
        const replacement = yield* connect("synthetic-replacement");
        // Connecting from the app links each shared account for the owner in turn, so the
        // replacement replaces the original as the owner's link; the member links the original.
        yield* linkAccount(actors.member, path, "service", original);
        const key = "known-idempotency-key";
        const start = (actor: Session, accounts?: { service: string[] }, selectedKey = key) =>
          api.request(actor, "POST", `${path}/workflow-runs`, {
            ...(accounts === undefined ? {} : { accounts }),
            workflow: "capture",
            input: { label: "retained" },
            key: selectedKey,
          });
        const wait = (actor: Session, id: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 15000;
            for (;;) {
              const response = yield* api.request(actor, "GET", `${path}/workflow-runs/${id}`);
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const run = yield* body(WorkflowRun, response);
              if (run.status === "complete") return run;
              expect(["queued", "running"]).toContain(run.status);
              expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
              yield* Effect.sleep("100 millis");
            }
          });
        const started = yield* start(actors.member);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const run = yield* wait(actors.member, (yield* body(Resource, started)).id);
        expect(run.output).toMatchObject({ account: original, value: "synthetic-original" });
        expect((yield* body(WorkflowRun, yield* start(actors.member))).output).toEqual(run.output);
        // A key belongs to the actor that used it. Another member linking the same account cannot
        // read or replay this run; the same key starts their own run.
        yield* linkAccount(actors.admin, path, "service", original);
        expect(
          (yield* api.request(actors.admin, "GET", `${path}/workflow-runs/${run.id}`)).status,
        ).toBe(403);
        const admin = yield* start(actors.admin);
        expect(admin.status, JSON.stringify(admin.body)).toBe(200);
        const adminRun = yield* wait(actors.admin, (yield* body(Resource, admin)).id);
        expect(adminRun.id).not.toBe(run.id);
        expect(adminRun.output).toMatchObject({ account: original });
        expect(adminRun.output).not.toEqual(run.output);
        const other = yield* start(actors.owner, { service: [replacement] });
        expect(other.status, JSON.stringify(other.body)).toBe(200);
        const otherRun = yield* wait(actors.owner, (yield* body(Resource, other)).id);
        expect(otherRun.id).not.toBe(run.id);
        expect(otherRun.output).toMatchObject({ account: replacement });
        const audience = (allowed: boolean) =>
          Effect.gen(function* () {
            const accessPath = `${prefix}/accounts/${original}/access`;
            const access = yield* body(Access, yield* api.request(actors.owner, "GET", accessPath));
            expect(
              (yield* api.request(actors.owner, "PATCH", accessPath, {
                revision: access.revision,
                audience: allowed ? { kind: "everyone" } : { kind: "groups", groups: [] },
              })).status,
            ).toBe(200);
          });
        // The member loses access to the original account and links the replacement instead.
        yield* audience(false);
        yield* unlinkAccount(actors.member, path, "service", original);
        yield* linkAccount(actors.member, path, "service", replacement);
        expect(
          (yield* api.request(actors.member, "GET", `${path}/workflow-runs/${run.id}`)).status,
        ).toBe(403);
        const denied = yield* start(actors.member);
        expect(
          denied.status,
          "Replaying a known key must not disclose output from a revoked account",
        ).toBe(403);
        expect(JSON.stringify(denied.body)).not.toContain("synthetic-original");
        const changedInput = () =>
          api.request(actors.member, "POST", `${path}/workflow-runs`, {
            workflow: "capture",
            input: { label: "different" },
            key,
          });
        // Authorization precedes comparing retained inputs, including the conflict response.
        expect((yield* changedInput()).status).toBe(403);
        const history = yield* api.request(actors.member, "GET", `${path}/workflow-runs`);
        expect(history.status).toBe(200);
        expect(
          (yield* body(Schema.Struct({ items: Schema.Array(Resource) }), history)).items,
        ).toEqual([]);
        const fresh = yield* start(actors.member, undefined, "new-key");
        expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
        const freshRun = yield* wait(actors.member, (yield* body(Resource, fresh)).id);
        expect(freshRun.id).not.toBe(run.id);
        expect(freshRun.output).toMatchObject({
          account: replacement,
          value: "synthetic-replacement",
        });
        const unkeyed = yield* api.request(actors.member, "POST", `${path}/workflow-runs`, {
          workflow: "capture",
          input: { label: "unkeyed" },
        });
        expect(unkeyed.status, JSON.stringify(unkeyed.body)).toBe(200);
        const unkeyedRun = yield* wait(actors.member, (yield* body(Resource, unkeyed)).id);
        expect(unkeyedRun.id).not.toBe(freshRun.id);
        expect(unkeyedRun.output).toMatchObject({ account: replacement, label: "unkeyed" });
        yield* audience(true);
        const conflict = yield* changedInput();
        expect(conflict.status).toBe(500);
        expect(conflict.body).toMatchObject({ reason: "conflict", retryable: false });
        const replay = yield* start(actors.member);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        const retained = yield* body(WorkflowRun, replay);
        expect(retained.id).toBe(run.id);
        expect(retained.output).toEqual(run.output);
        expect(retained.status).toBe("complete");
      }),
    ),
  );
});
