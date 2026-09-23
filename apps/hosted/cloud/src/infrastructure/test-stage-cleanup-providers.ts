/** Cleanup runs from a shared checkout; local build files are not owned by a remote preview. */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
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

/** Failed first deployments leave an empty Worker stub with no reachable drain endpoint. */
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
            if (stage.startsWith("test-") && input.olds.deployment === undefined) {
              const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
              const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
              const http = yield* HttpClient.HttpClient;
              const response = yield* http.execute(
                HttpClientRequest.get(
                  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(input.olds.workerName)}/content/v2`,
                ).pipe(HttpClientRequest.bearerToken(token)),
              );
              if (response.status === 404) return;
              if (response.status !== 200) return yield* new PlaceholderCheckFailed();
              const contentType = response.headers["content-type"];
              if (contentType === undefined) return yield* new PlaceholderCheckFailed();
              const content = yield* response.text;
              const form = yield* Effect.tryPromise({
                try: () =>
                  new Response(content, { headers: { "content-type": contentType } }).formData(),
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
              !input.output.bucketName.startsWith("executor-next-hosted-appbuilds-test-")
            )
              return yield* Effect.die(
                new Error("Refusing to empty a bucket outside a test preview."),
              );
            yield* native.delete({ ...input, olds: { ...input.olds, forceDestroy: true } });
          }),
      };
    }).pipe(Effect.provide(Cloudflare.providers())),
  );
