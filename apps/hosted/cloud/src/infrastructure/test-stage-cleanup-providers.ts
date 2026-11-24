/** Cleanup runs from a shared checkout; local build files are not owned by a remote preview. */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { StackContext } from "alchemy/StackContext";
import { State } from "alchemy/State/State";
import { Config, Console, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { appDomainControlSecretId } from "./app-domain-control.ts";
import { AppDomainLifecycle, AppDomainLifecycleProvider } from "./app-domain-lifecycle.ts";

/** Only Alchemy's exact empty precreate script can have no runtime-owned team DNS. */
export const isAlchemyWorkerPlaceholder = (script: string) =>
  /^(?:import \{ DurableObject \} from "cloudflare:workers";\n\n)?export default \{ fetch\(\) \{ return new Response\("Alchemy worker is being deployed\.\.\."\) \} \};\n(?:export class [A-Za-z_$][\w$]* extends DurableObject \{\}(?:\n|$))*$/.test(
    script,
  );

class PlaceholderCheckFailed extends Schema.TaggedError<PlaceholderCheckFailed>()(
  "PlaceholderCheckFailed",
  {},
) {}

/**
 * Failed first deployments leave an empty Worker stub with no reachable drain endpoint. A teardown
 * that stopped after deleting the stage's Workers and its control secret leaves only this record,
 * whose drain can never be answered: with the API Worker gone (404) and no secret recorded, it is
 * forgotten instead of failing every scheduled cleanup.
 */
export const TestStageDomainCleanup = () =>
  Provider.effect(
    AppDomainLifecycle,
    Effect.gen(function* () {
      const native = yield* Provider.findProvider(AppDomainLifecycle);
      return {
        ...native,
        delete: (input: Parameters<typeof native.delete>[0]) =>
          Effect.gen(function* () {
            const stage = yield* Stage;
            if (!stage.startsWith("test-")) return yield* native.delete(input);
            const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
            const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
            // A recorded copy of the API can stand in for it (`test-stage-domain-cleanup.spec.ts`).
            const api = yield* Config.String("TEST_STAGE_CLOUDFLARE_API").pipe(
              Config.withDefault("https://api.cloudflare.com"),
            );
            const http = yield* HttpClient.HttpClient;
            const content = http
              .execute(
                HttpClientRequest.get(
                  `${api}/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(input.olds.workerName)}/content/v2`,
                ).pipe(HttpClientRequest.bearerToken(token)),
              )
              .pipe(Effect.mapError(() => new PlaceholderCheckFailed()));
            if (input.olds.deployment === undefined) {
              const response = yield* content;
              if (response.status === 404) return;
              if (response.status !== 200) return yield* new PlaceholderCheckFailed();
              const contentType = response.headers["content-type"];
              if (contentType === undefined) return yield* new PlaceholderCheckFailed();
              const text = yield* response.text;
              const form = yield* Effect.tryPromise({
                try: () =>
                  new Response(text, { headers: { "content-type": contentType } }).formData(),
                catch: () => new PlaceholderCheckFailed(),
              });
              const files: Array<string | File> = [];
              form.forEach((file) => files.push(file));
              const file = files[0];
              if (files.length === 1 && file instanceof File) {
                const script = yield* Effect.tryPromise({
                  try: () => file.text(),
                  catch: () => new PlaceholderCheckFailed(),
                });
                if (isAlchemyWorkerPlaceholder(script)) return;
              }
            } else {
              const state = yield* yield* State;
              const stack = yield* StackContext;
              const secret = yield* state.get({
                stack: stack.name,
                stage,
                fqn: appDomainControlSecretId,
              });
              if (secret === undefined && (yield* content).status === 404) {
                yield* Console.log(
                  `${stage}: its API Worker ${input.olds.workerName} is gone and no app domain control secret is recorded, so nothing can answer a drain. Forgetting its app domain lifecycle record.`,
                );
                return;
              }
            }
            // Any uploaded application, including one whose state commit failed,
            // still has to drain. Never turn an unavailable real app into success.
            yield* native.delete(input);
          }).pipe(Effect.timeout("2 minutes")),
      };
    }).pipe(Effect.provide(AppDomainLifecycleProvider())),
  );

/** Forget a completed build's state without deleting another deploy's local output directory. */
export const TestStageBuildCleanup = () =>
  Provider.succeed(Command.Build, {
    read: ({ output }) => Effect.succeed(output),
    reconcile: () =>
      Effect.die(new Error("This provider only removes remote preview build records.")),
    delete: () => Effect.void,
  });

/** The buckets a test stage owns: retained app builds and retained site assets. */
const testStageBuckets = [
  "executor-next-hosted-appbuilds-test-",
  "executor-next-hosted-siteassets-test-",
];

/** An authorized preview teardown includes its bucket contents, including older persisted props. */
export const TestStageBucketCleanup = () =>
  Provider.effect(
    Cloudflare.R2.Bucket,
    Effect.gen(function* () {
      const native = yield* Provider.findProvider(Cloudflare.R2.Bucket);
      return {
        ...native,
        delete: (input: Parameters<typeof native.delete>[0]) =>
          Effect.gen(function* () {
            const stage = yield* Stage;
            if (
              !stage.startsWith("test-") ||
              !testStageBuckets.some((prefix) => input.output.bucketName.startsWith(prefix))
            )
              return yield* Effect.die(
                new Error("Refusing to empty a bucket outside a test preview."),
              );
            yield* native.delete({ ...input, olds: { ...input.olds, forceDestroy: true } });
          }),
      };
    }).pipe(Effect.provide(Cloudflare.providers())),
  );
