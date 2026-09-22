/** Cleanup runs from a shared checkout; local build files are not owned by a remote preview. */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";

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
