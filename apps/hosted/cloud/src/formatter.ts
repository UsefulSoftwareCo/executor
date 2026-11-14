/**
 * Private source formatter and Markdown reader. Prettier's parsers are about 1.5 MB of JavaScript
 * and the Markdown parser about 110 KB; in this small Worker they cost startup only when someone
 * views source or deploys setup help, not on every API cold start.
 */
import { formatSources } from "@executor-js/app-management/source-format";
import { SourceTextFile as SourceFile } from "@executor-js/sdk/core";
import { markdownRefusals } from "@executor-js/sdk/markdown";
import { withRemoteSpan } from "@executor-js/telemetry";
import { Effect, Schema } from "effect";
import { Formatter } from "./infrastructure/formatter-worker.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";

export default Formatter.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      build: workerBuild("formatter"),
      // No placement: a service binding runs this Worker beside its caller, the placed API Worker.
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
      env: yield* telemetryBindings,
    };
  }),
  Effect.sync(() =>
    Formatter.of({
      format: (files, headers) =>
        Schema.decodeUnknownEffect(Schema.Array(SourceFile))(files).pipe(
          Effect.flatMap(formatSources),
          Effect.orDie,
          withRemoteSpan(new Request("https://formatter.internal", { headers }), "source.format"),
        ),
      markdown: (texts, headers) =>
        Schema.decodeUnknownEffect(Schema.Array(Schema.String))(texts).pipe(
          Effect.flatMap(markdownRefusals),
          Effect.orDie,
          withRemoteSpan(new Request("https://formatter.internal", { headers }), "markdown.parse"),
        ),
    }),
  ).pipe(Effect.provide(cloudTelemetry)),
);
