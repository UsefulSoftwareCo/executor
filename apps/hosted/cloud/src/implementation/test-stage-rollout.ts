import { Console, Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestStageFailed } from "../contracts/test-stage-lifetime.ts";

const Health = Schema.Struct({ status: Schema.Literal("ok") });

const requiredAnswers = 20;

const healthRoles = ["app", "api"] as const;

const certificateWait = "10 minutes";

export const awaitStageRollout = (origin: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const answer = (at: string) =>
      client.get(`${at}/health`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Health)),
        Effect.match({ onSuccess: () => true, onFailure: () => false }),
      );
    yield* Effect.gen(function* () {
      let consecutive = 0;
      let other = 0;
      while (consecutive < requiredAnswers) {
        if (yield* answer(origin)) consecutive++;
        else {
          consecutive = 0;
          other++;
        }
        yield* Effect.sleep("1 second");
      }
      yield* Console.log(
        `Rollout complete: ${requiredAnswers} consecutive API answers after ${other} other responses.`,
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: "3 minutes",
        orElse: () =>
          Effect.fail(
            new TestStageFailed({
              message: `${origin} did not finish rolling out its API Worker.`,
            }),
          ),
      }),
    );
    const { protocol, host } = new URL(origin);
    for (const role of healthRoles) {
      const at = `${protocol}//${role}.${host}`;
      yield* Effect.gen(function* () {
        let attempts = 1;
        while (!(yield* answer(at))) {
          attempts++;
          yield* Effect.sleep("5 seconds");
        }
        yield* Console.log(`${at} answers, after ${attempts} attempt(s).`);
      }).pipe(
        Effect.timeoutOrElse({
          duration: certificateWait,
          orElse: () =>
            Effect.fail(
              new TestStageFailed({
                message: `${at} did not return a valid /health response within ${certificateWait}.`,
              }),
            ),
        }),
      );
    }
  });
