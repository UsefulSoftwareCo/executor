import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Option, Schema } from "effect";

export const CloudJurisdiction = Schema.Literals(["eu", "fedramp"]);
export type CloudJurisdiction = typeof CloudJurisdiction.Type;

export const cloudJurisdiction = Config.Literals(
  CloudJurisdiction.literals,
  "CLOUD_JURISDICTION",
).pipe(Config.option);

const configured = Effect.gen(function* () {
  return Option.getOrUndefined(yield* cloudJurisdiction);
}).pipe(Effect.orDie);

export const bucketJurisdiction = configured.pipe(
  Effect.map((jurisdiction) => (jurisdiction === undefined ? {} : { jurisdiction })),
);

const NativeNamespace = Schema.declare(
  (value): value is DurableObjectNamespace =>
    typeof value === "object" &&
    value !== null &&
    "jurisdiction" in value &&
    typeof value.jurisdiction === "function" &&
    "get" in value &&
    typeof value.get === "function" &&
    "idFromName" in value &&
    typeof value.idFromName === "function" &&
    "idFromString" in value &&
    typeof value.idFromString === "function" &&
    "getByName" in value &&
    typeof value.getByName === "function",
);

export const durableNamespace = (binding: string) => Effect.map(resolver(binding), Effect.sync);

const resolver = (binding: string) =>
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    const jurisdiction = yield* configured;
    return () => {
      const namespace = Schema.decodeUnknownSync(NativeNamespace)(environment[binding]);
      return jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction);
    };
  });

export const inJurisdiction = <Shape, E, R>(
  handle: Effect.Effect<Cloudflare.DurableObject<Shape>, E, R>,
) =>
  Effect.gen(function* () {
    const durable = yield* handle;
    const jurisdiction = yield* configured;
    if (jurisdiction === undefined) return durable;
    const namespace = yield* resolver(durable.name);
    return {
      ...durable,
      getByName: (name, options) =>
        Cloudflare.makeRpcStub<Cloudflare.DurableObjectStub<Shape>>(
          namespace().getByName(name, options),
        ),
    } satisfies Cloudflare.DurableObject<Shape>;
  });
