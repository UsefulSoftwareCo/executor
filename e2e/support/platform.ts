import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { RunMetadata } from "../report-model.ts";
import { FixtureControl, PreparedScenarios } from "../sdk/contracts.ts";
import { indented, keepCause, keptCauseText, secretConfig } from "./failure-text.ts";

export const RecordingPaceMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3000 }));

export class Target extends Context.Service<
  Target,
  {
    readonly metadata: typeof RunMetadata.Type;
    readonly directory: string;
    readonly tlsCertificate?: string;
    readonly apiKey: Redacted.Redacted<string>;
    readonly rows: number;
    readonly observeUI: boolean;
    readonly headless?: boolean;
    readonly recordingPaceMs: typeof RecordingPaceMs.Type;
    readonly fixtures?: typeof FixtureControl.Type;
    readonly controlOrigin?: string;
    readonly evidenceDirectory?: string;
    readonly preparedScenarios?: typeof PreparedScenarios.Type;
    readonly scenarioId?: string;
    readonly scenarioLabel?: string;
  }
>()("e2e/Target") {
  static readonly layer = Layer.effect(
    Target,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* Config.String("EXECUTOR_E2E_RUN");
      const metadata = yield* fs
        .readFileString(`${directory}/run.json`)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RunMetadata))));
      const apiKey = yield* secretConfig("EXECUTOR_E2E_API_KEY");
      const recordingPaceMs = yield* Config.Number("E2E_RECORDING_PACE_MS").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RecordingPaceMs)),
      );
      const observeUI = yield* Config.Boolean("E2E_UI_OBSERVE").pipe(Config.withDefault(false));
      const fixtures = yield* Config.String("E2E_FIXTURES").pipe(Config.withDefault(""));
      const rows = yield* Config.Number("E2E_ROWS").pipe(
        Config.withDefault(300),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
          ),
        ),
      );
      return {
        metadata,
        directory,
        preparedScenarios: yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(PreparedScenarios),
        )(
          (yield* fs.exists(`${directory}/prepared-scenarios.json`))
            ? yield* fs.readFileString(`${directory}/prepared-scenarios.json`)
            : "{}",
        ),
        apiKey,
        rows,
        recordingPaceMs,
        observeUI,
        ...(fixtures === ""
          ? {}
          : {
              fixtures: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureControl))(
                fixtures,
              ),
            }),
      };
    }),
  );
}
export const RuntimeLive = Target.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);
export class DriverFailed extends Schema.TaggedError<DriverFailed>()("DriverFailed", {
  operation: Schema.String,
  cause: Schema.Redacted(Schema.Unknown),
}) {
  get message() {
    return `Driver operation failed: ${this.operation}\n  ${indented(keptCauseText(this) ?? "A redacted value")}`;
  }
}
export const withCause = <E extends { readonly cause?: Redacted.Redacted<unknown> | undefined }>(
  error: E,
): E => {
  keepCause(error, error.cause);
  return error;
};
export const driver = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => withCause(new DriverFailed({ operation, cause: Redacted.make(cause) })),
  });
export interface Response {
  readonly status: number;
  readonly body: unknown;
}
