/** Durable human input through the actual hosted HTTP and workflow engine. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { serverControl } from "../support/server-control.ts";
import { workflowInputFiles } from "../support/workflow-input-app.ts";
import { freeSeat } from "../support/seats.ts";
import { scenarios } from "../test-plan.ts";

const Input = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  app: Schema.String,
  status: Schema.String,
  reviewUrl: Schema.optionalKey(Schema.String),
});
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
});
const fixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deploy = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: "Durable input fixture",
    files: workflowInputFiles,
  });
  expect(deploy.status, JSON.stringify(deploy.body)).toBe(200);
  const app = yield* body(Schema.Struct({ id: Schema.String }), deploy);
  const path = `${prefix}/apps/${app.id}`;
  const runs: Array<{ id: string; actor: Session }> = [];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const run of runs)
        yield* api.request(run.actor, "POST", `${path}/workflow-runs/${run.id}/terminate`);
      expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
    }).pipe(Effect.orDie),
  );
  const start = (
    timeoutMs = 86400000,
    protectedAction = "no",
    actor = actors.owner,
    workflow = "ask",
  ) =>
    Effect.gen(function* () {
      const response = yield* api.request(actor, "POST", `${path}/workflow-runs`, {
        workflow,
        input: { timeoutMs, protected: protectedAction },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const run = yield* body(Run, response);
      runs.push({ id: run.id, actor });
      return run;
    });
  const pending = (run: string, actor = actors.owner) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + 20000;
      while (true) {
        const response = yield* api.request(actor, "GET", `${prefix}/workflow-inputs?pending=true`);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const input = (yield* body(
          Schema.Struct({ items: Schema.Array(Input) }),
          response,
        )).items.find((input) => input.run === run);
        if (input !== undefined) return input;
        expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
        yield* Effect.sleep("50 millis");
      }
    });
  const wait = (run: string) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + 20000;
      while (true) {
        const response = yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${run}`);
        expect(response.status).toBe(200);
        const result = yield* body(Run, response);
        if (["complete", "errored", "terminated"].includes(result.status)) return result;
        expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
        yield* Effect.sleep("50 millis");
      }
    });
  const answer = (id: string, choice: string, actor = actors.owner) =>
    api.request(actor, "POST", `${path}/workflow-inputs/${id}`, {
      response: { action: "accept", content: { choice } },
    });
  const rows = () =>
    api.request(actors.owner, "POST", `${path}/tools/call`, {
      tool: "rows",
      kind: "query",
      input: {},
    });
  const share = (kind: "private" | "everyone") =>
    Effect.gen(function* () {
      const access = yield* body(
        Schema.Struct({ revision: Schema.String }),
        yield* api.request(actors.owner, "GET", `${path}/access`),
      );
      expect(
        (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
          revision: access.revision,
          audience: { kind },
        })).status,
      ).toBe(200);
    });
  return { api, actors, prefix, path, start, pending, wait, answer, rows, share };
});

layer(HostedLive, { excludeTestServices: true })("Durable workflow input", (it) => {
  it.effect(scenarios.workflowInputLifecycle.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* fixture;
        const run = yield* f.start();
        const input = yield* f.pending(run.id);
        expect(input.reviewUrl).toContain(`/approvals/workflow/${input.app}/${input.id}`);
        expect(
          (yield* f.api.request(f.actors.owner, "GET", `${f.path}/workflow-inputs/${input.id}`))
            .body,
        ).toMatchObject({ evidence: [{ label: "Origin", value: "synthetic" }] });
        const evidence = [{ label: "Latest check", value: "source-rejected" }];
        const updated = yield* f.api.request(
          f.actors.owner,
          "POST",
          `${f.path}/workflow-inputs/${input.id}/evidence`,
          { evidence },
        );
        expect(updated.status).toBe(200);
        expect(updated.body).toMatchObject({ id: input.id, status: "pending", evidence });
        expect((yield* f.answer(input.id, "invalid")).status).toBe(400);
        expect((yield* f.pending(run.id)).id).toBe(input.id);
        // Crash recovery must use the same question and its retained workflow, without an MCP session.
        yield* serverControl("restart");
        expect((yield* f.pending(run.id)).id).toBe(input.id);
        expect(
          (yield* f.api.request(f.actors.owner, "GET", `${f.path}/workflow-inputs/${input.id}`))
            .body,
        ).toMatchObject({ evidence });
        const responses = yield* Effect.all(
          [f.answer(input.id, "continue"), f.answer(input.id, "defer")],
          { concurrency: 2 },
        );
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        const result = yield* f.wait(run.id);
        expect(result.status).toBe("complete");
        const receipts = yield* f.rows();
        expect(receipts.status).toBe(200);
        expect(receipts.body).toEqual([
          expect.objectContaining({
            question: input.id,
            answer: expect.stringMatching(/^(continue|defer)$/),
          }),
        ]);
        expect((yield* f.answer(input.id, "continue")).status).toBe(200);
        expect(
          (yield* f.api.request(
            f.actors.owner,
            "POST",
            `${f.path}/workflow-inputs/${input.id}/evidence`,
            { evidence: [] },
          )).body,
        ).toMatchObject({ status: "answered", evidence });
        expect((yield* f.rows()).body).toEqual(receipts.body);
        expect(
          (yield* f.api.request(f.actors.owner, "GET", `${f.prefix}/workflow-inputs?pending=true`))
            .body,
        ).toMatchObject({ items: [] });
      }),
    ),
  );
  it.effect(scenarios.workflowInputPagination.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.share("everyone");
        const run = yield* f.start(86400000, "no", f.actors.member, "many");
        yield* f.pending(run.id, f.actors.member);
        const Page = Schema.Struct({
          items: Schema.Array(Input),
          next: Schema.optionalKey(Schema.String),
        });
        const page = (after?: string) =>
          f.api
            .request(
              f.actors.member,
              "GET",
              `${f.prefix}/workflow-inputs?pending=true${after ? `&after=${after}` : ""}`,
            )
            .pipe(Effect.flatMap((response) => body(Page, response)));
        const deadline = (yield* Clock.currentTimeMillis) + 60000;
        while (true) {
          const first = yield* page();
          const second = first.next === undefined ? undefined : yield* page(first.next);
          if (first.items.length === 100 && second?.items.length === 5) break;
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          yield* Effect.sleep("50 millis");
        }
        yield* Effect.addFinalizer(() => f.share("everyone").pipe(Effect.orDie));
        yield* f.share("private");
        const hidden = yield* page();
        expect(hidden.items).toEqual([]);
        expect(hidden.next).toBeDefined();
        const final = yield* page(hidden.next);
        expect(final.items).toEqual([]);
        expect(final.next).toBeUndefined();
      }),
    ),
  );
  it.effect(scenarios.workflowInputRevocation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.share("everyone");
        const run = yield* f.start(86400000, "no", f.actors.member);
        const question = yield* f.pending(run.id, f.actors.member);
        const read = () =>
          f.api.request(f.actors.member, "GET", `${f.path}/workflow-inputs/${question.id}`);
        expect((yield* read()).status).toBe(200);
        yield* f.share("private");
        expect((yield* read()).status).toBe(403);
        expect((yield* f.answer(question.id, "continue", f.actors.member)).status).toBe(403);
        yield* f.share("everyone");
        expect((yield* read()).body).toMatchObject({ status: "pending" });
        const seat = yield* freeSeat;
        yield* Effect.addFinalizer(() => seat.rejoin.pipe(Effect.orDie));
        expect((yield* read()).status).toBe(403);
        expect((yield* f.answer(question.id, "continue", f.actors.member)).status).toBe(403);
        expect((yield* f.rows()).body).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.workflowInputAuthority.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.share("everyone");
        expect(
          (yield* f.api.request(f.actors.member, "POST", `${f.path}/tools/call`, {
            tool: "rows",
            kind: "query",
            input: {},
          })).status,
        ).toBe(200);
        const run = yield* f.start(86400000, "yes");
        const input = yield* f.pending(run.id);
        expect(
          (yield* f.api.request(f.actors.member, "GET", `${f.path}/workflow-inputs/${input.id}`))
            .status,
        ).toBeGreaterThanOrEqual(400);
        expect(
          (yield* f.api.request(f.actors.member, "POST", `${f.path}/workflow-inputs/${input.id}`, {
            response: { action: "accept", content: { choice: "continue" } },
          })).status,
        ).toBeGreaterThanOrEqual(400);
        expect((yield* f.answer(input.id, "continue")).status).toBe(200);
        expect(yield* f.wait(run.id)).toMatchObject({ status: "errored", error: "approval" });
        const withdrawn = yield* f.start();
        const old = yield* f.pending(withdrawn.id);
        expect(
          (yield* f.api.request(
            f.actors.owner,
            "POST",
            `${f.path}/workflow-inputs/${old.id}/withdraw`,
          )).status,
        ).toBe(200);
        expect(yield* f.wait(withdrawn.id)).toMatchObject({
          status: "complete",
          output: { status: "withdrawn" },
        });
        expect((yield* f.answer(old.id, "continue")).body).toMatchObject({ status: "withdrawn" });
        const expired = yield* f.start(1000);
        expect(yield* f.wait(expired.id)).toMatchObject({
          status: "complete",
          output: { status: "expired" },
        });
        expect((yield* f.rows()).body).toHaveLength(1);
      }),
    ),
  );
});
