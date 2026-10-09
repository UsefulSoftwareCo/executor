/** Wait until a deployed stage answers only from its real API Worker, on each of its hosts. */
import { Console, Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestStageFailed } from "../contracts/test-stage-lifetime.ts";

const Health = Schema.Struct({ status: Schema.Literal("ok") });

/**
 * Consecutive real answers, one second apart, that end the rollout wait.
 * In a measured fresh deployment, about a third of requests reached the
 * placeholder for 20 seconds after Alchemy finished, interleaved with real answers.
 */
const requiredAnswers = 20;

/**
 * The role hosts that answer `/health` (`infrastructure/role-hosts.ts`): `app.` serves the
 * dashboard and sign-in, `api.` the API. `mcp.` serves only MCP, under the same certificate.
 */
const healthRoles = ["app", "api"] as const;

/**
 * A test stage's role hosts use its custom-domain certificate for `*.<slug>.<test domain>`, which
 * Cloudflare issues after Alchemy finishes: 1.5 to 4 minutes later in measured PR previews. Until
 * then their TLS handshake fails, while the deployment origin, under the zone's certificate,
 * already answers.
 */
const certificateWait = "10 minutes";

/**
 * Alchemy first uploads a placeholder API Worker, which answers every path with
 * HTTP 200 plain text, and then uploads the real one. Cloudflare rolls the new
 * version out gradually, so for a while after the upload requests reach either
 * version. A session object started on the placeholder is reset when the real code
 * arrives, which ends its streams. Only an unbroken run of real `/health` answers
 * shows that the rollout has finished.
 *
 * The role hosts beside the deployment origin, `<role>.<deployment host>` (`stage.ts`), reach the
 * same Worker, so one real answer from each shows that its certificate and route serve it.
 */
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
