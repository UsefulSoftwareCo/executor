/** Shared test runtime: native services and a real clock, with no application imports. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RunMetadata } from "../report-model.ts";

/** Per-action capture delay; zero keeps unattended runs at full speed. */
export const RecordingPaceMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3000 }));

/** Runtime facts supplied once by the scoped runner, not inferred by scenarios. */
export class Target extends Context.Service<
  Target,
  {
    readonly metadata: typeof RunMetadata.Type;
    readonly directory: string;
    readonly apiKey: Redacted.Redacted<string>;
    readonly cloudActors: string | undefined;
    readonly rows: number;
    readonly observeUI: boolean;
    readonly recordingPaceMs: typeof RecordingPaceMs.Type;
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
      const apiKey = yield* Config.Redacted("EXECUTOR_E2E_API_KEY");
      const recordingPaceMs = yield* Config.Number("E2E_RECORDING_PACE_MS").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RecordingPaceMs)),
      );
      const observeUI = yield* Config.Boolean("E2E_UI_OBSERVE").pipe(Config.withDefault(false));
      const cloudActors = yield* Config.String("E2E_CLOUD_ACTORS").pipe(Config.withDefault(""));
      const rows = yield* Config.Number("E2E_ROWS").pipe(
        Config.withDefault(1000),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
          ),
        ),
      );
      return {
        metadata,
        directory,
        apiKey,
        cloudActors: cloudActors || undefined,
        rows,
        recordingPaceMs,
        observeUI,
      };
    }),
  );
}
/** Runtime shared by Effect Vitest layers; target resources belong to the runner. */
export const RuntimeLive = Target.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);
/** Boundary failure with a safe operation label; raw SDK errors stay redacted. */
export class DriverFailed extends Schema.TaggedError<DriverFailed>()("DriverFailed", {
  operation: Schema.String,
  cause: Schema.Redacted(Schema.Unknown),
}) {
  get message() {
    return `Driver operation failed: ${this.operation}`;
  }
}
/** Lift exactly one third-party operation. Orchestration stays in Effect. */
export const driver = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DriverFailed({ operation, cause: Redacted.make(cause) }),
  });
/** Public wire response, fully consumed inside the request scope. */
export interface Response {
  readonly status: number;
  readonly body: unknown;
}
