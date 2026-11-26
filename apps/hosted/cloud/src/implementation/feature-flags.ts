import { Context, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const Flags = Schema.Struct({
  flags: Schema.Record(Schema.String, Schema.Unknown),
  errorsWhileComputingFlags: Schema.Boolean,
  quotaLimited: Schema.optional(Schema.Array(Schema.String)),
});
const Flag = Schema.Struct({ enabled: Schema.Boolean, variant: Schema.optional(Schema.String) });

export const evaluateFlags = <const Key extends string>(
  settings: { readonly token: string; readonly host: string },
  keys: readonly Key[],
  distinctId: string,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${settings.host}/flags?v=2`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          api_key: settings.token,
          distinct_id: distinctId,
          flag_keys_to_evaluate: keys,
        }),
      ),
    );
    if (response.status !== 200) return yield* Effect.fail("Flag evaluation unavailable");
    const result = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Flags)));
    if (result.errorsWhileComputingFlags || result.quotaLimited?.includes("feature_flags"))
      return yield* Effect.fail("Flag evaluation incomplete");
    const variants: Partial<Record<Key, string>> = {};
    for (const key of keys) {
      const value = result.flags[key];
      if (value === undefined) continue;
      const flag = yield* Schema.decodeUnknownEffect(Flag)(value);
      if (flag.enabled && flag.variant !== undefined) variants[key] = flag.variant;
    }
    return variants;
  }).pipe(
    Effect.timeout("1 second"),
    Effect.catch(() =>
      Effect.logWarning("Feature flags unavailable; serving untracked controls").pipe(
        Effect.as<Partial<Record<Key, string>>>({}),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped,
  );

export const FeatureFlags = Context.Reference<{
  readonly evaluate: <const Key extends string>(
    keys: readonly Key[],
    distinctId: string,
  ) => Effect.Effect<Partial<Record<Key, string>>>;
}>("cloud/FeatureFlags", {
  defaultValue: () => ({ evaluate: () => Effect.succeed({}) }),
});
