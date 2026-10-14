/** Prove a deployed stage compiles apps before any scenario sends its first deploy. */
import { Clock, Console, Effect, Layer, Schedule, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { SessionClients, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { startScenario } from "./scenario.ts";

/** One deploy attempt that the stage did not answer with a built app. */
class CompilerAttemptFailed extends Schema.TaggedError<CompilerAttemptFailed>()(
  "CompilerAttemptFailed",
  {
    status: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.String),
  },
) {}

/** The stage did not build a sample app through its public API within the deadline. */
export class CompilerNotReady extends Schema.TaggedError<CompilerNotReady>()("CompilerNotReady", {
  attempts: Schema.Number,
  elapsedMs: Schema.Number,
  status: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
}) {
  override get message() {
    const last = this.status === undefined ? (this.reason ?? "timeout") : `HTTP ${this.status}`;
    return `The stage's app compiler did not build a sample app after ${this.attempts} attempt(s) in ${Math.round(this.elapsedMs / 1000)}s (last: ${last})`;
  }
}

const source = `import { defineApp, object, query, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({ ping: query({ description: "Compiler readiness", input: object({}) }, async () => "ok") }),
}));`;

/**
 * A fresh compiler Worker can lose its first requests while it starts; scenarios that deploy at
 * that moment hang past their own deadline. A dedicated organization deploys one small app
 * through `POST /apps/deploy`, retrying unanswered or failed requests until one builds. A client
 * error is the probe's own fault and fails at once. The organization is removed afterwards.
 */
export const awaitCompiler = (base: typeof Target.Service, deadline: "5 minutes") =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    let attempts = 0;
    let last: CompilerAttemptFailed | undefined;
    const target = yield* startScenario(
      base,
      "Compiler readiness",
      randomBytes(16).toString("hex"),
    );
    const outcome = yield* Effect.gen(function* () {
      const actors = yield* Actors;
      const api = yield* SessionClients;
      const prefix = `/api/organizations/${actors.organization.id}`;
      const deploy = Effect.gen(function* () {
        attempts++;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Compiler readiness ${attempts}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        if (response.status !== 200)
          return yield* new CompilerAttemptFailed({ status: response.status });
        return yield* body(App, response).pipe(
          Effect.mapError(() => new CompilerAttemptFailed({ reason: "response" })),
        );
      }).pipe(
        Effect.catchTag("RequestFailed", (error) =>
          Effect.fail(new CompilerAttemptFailed({ reason: error.reason })),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            last = error;
          }),
        ),
      );
      const app = yield* deploy.pipe(
        Effect.retry({
          schedule: Schedule.spaced("2 seconds"),
          while: (error) =>
            error.status === undefined || error.status >= 500 || error.status === 429,
        }),
        Effect.timeout(deadline),
        Effect.result,
      );
      if (app._tag === "Success")
        yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.success.id}`);
      return app;
    }).pipe(
      Effect.provide(
        Actors.layer.pipe(
          Layer.provideMerge(SessionClients.layer),
          Layer.provide(Layer.succeed(Target, target)),
        ),
      ),
      Effect.scoped,
    );
    const elapsedMs = (yield* Clock.currentTimeMillis) - started;
    if (outcome._tag === "Failure")
      return yield* new CompilerNotReady({
        attempts,
        elapsedMs,
        status: last?.status,
        reason: last?.reason,
      });
    yield* Console.log(
      `App compiler ready: ${Math.round(elapsedMs / 1000)}s (${attempts} deploy attempt(s)).`,
    );
    return { attempts, elapsedMs };
  });
