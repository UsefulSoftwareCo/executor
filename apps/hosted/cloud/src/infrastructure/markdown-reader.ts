import { MarkdownRefusals, MarkdownUnavailable, type MarkdownReader } from "@executor-js/sdk/core";
import { traceHeaders } from "@executor-js/telemetry";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import { Formatter } from "./formatter-worker.ts";

export const cloudMarkdownReader = Effect.gen(function* () {
  const formatter = yield* Cloudflare.Workers.bindWorker(Formatter);
  const environment = yield* Cloudflare.WorkerEnvironment;
  const unavailable = (reason: string) =>
    Effect.logWarning(`Markdown check unavailable: ${reason}`).pipe(
      Effect.andThen(Effect.fail(new MarkdownUnavailable())),
    );
  const read: MarkdownReader = (texts) =>
    traceHeaders.pipe(
      Effect.flatMap((headers) =>
        formatter.markdown(texts, Object.fromEntries(Object.entries(headers))),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MarkdownRefusals))),
      Effect.provideService(Cloudflare.WorkerEnvironment, environment),
      Effect.catchTags({
        RpcCallError: (error) => unavailable(error.message),
        SchemaError: () => unavailable("the Formatter's answer has another shape"),
      }),
      Effect.flatMap((refusals) =>
        refusals.length === texts.length
          ? Effect.succeed(refusals)
          : unavailable(`the Formatter answered ${refusals.length} of ${texts.length} texts`),
      ),
      Effect.withSpan("markdown.read", { attributes: { "markdown.texts": texts.length } }),
    );
  return read;
});
