/** Authored Markdown is parsed in the Formatter Worker, so the API Worker never uploads the parser. */
import { MarkdownRefusals, MarkdownUnavailable, type MarkdownReader } from "@executor-js/sdk/core";
import { traceHeaders } from "@executor-js/telemetry";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import { Formatter } from "./formatter-worker.ts";

/**
 * Deploys read setup help through this. Unlike formatting, a read is never skipped: when the
 * Formatter does not answer, or answers in a shape this release does not read, as a Formatter from
 * another release could, the deploy fails with `MarkdownUnavailable` and saves nothing. The
 * warning never quotes an answer, whose links come from the Markdown.
 */
export const cloudMarkdownReader = Effect.gen(function* () {
  const formatter = yield* Cloudflare.Workers.bindWorker(Formatter);
  // Bound here, as the runtime's bindings are, so a read does not depend on its caller's services.
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
