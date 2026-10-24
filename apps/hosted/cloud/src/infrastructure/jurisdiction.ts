/**
 * Where Cloud keeps Durable Object and R2 data. `CLOUD_JURISDICTION` names a Cloudflare
 * jurisdiction both offer (`eu` or `fedramp`); unset, the default, leaves every namespace and
 * bucket where Cloudflare places it.
 *
 * A Durable Object's jurisdiction is part of its ID: `getByName`, `idFromName` and `idFromString`
 * on the jurisdiction's namespace and on the plain one address different objects, and their IDs
 * never compare equal. So every caller reaches a namespace through this module, never through its
 * Alchemy handle or binding directly; `scripts/check-jurisdiction.ts` fails on any that does not.
 *
 * The setting is read while each Worker initializes, which binds it onto that Worker, so every
 * Worker that addresses a namespace carries it without listing it.
 */
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

/** An R2 bucket's props for the configured jurisdiction; its binding follows the bucket. */
export const bucketJurisdiction = configured.pipe(
  Effect.map((jurisdiction) => (jurisdiction === undefined ? {} : { jurisdiction })),
);

const NativeNamespace = Schema.declare(
  (value): value is DurableObjectNamespace =>
    typeof value === "object" &&
    value !== null &&
    "jurisdiction" in value &&
    typeof value.jurisdiction === "function" &&
    "getByName" in value &&
    typeof value.getByName === "function",
);

/**
 * The native namespace this Worker binds as `binding`, in the configured jurisdiction, for the
 * calls Alchemy's handle does not offer (`idFromName`, `idFromString`, `get`, a raw `fetch`).
 * Build it while the Worker initializes; the namespace resolves when the returned effect runs.
 */
export const durableNamespace = (binding: string) => Effect.map(resolver(binding), Effect.sync);

/** Resolves the binding on each call: it only exists at runtime, not while a deploy plans. */
const resolver = (binding: string) =>
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    const jurisdiction = yield* configured;
    return () => {
      const namespace = Schema.decodeUnknownSync(NativeNamespace)(environment[binding]);
      return jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction);
    };
  });

/**
 * An Alchemy Durable Object handle whose `getByName` addresses the configured jurisdiction. Wrap
 * every `.from(...)` or `yield*` of a Durable Object class in this while the Worker initializes.
 * Unset, the handle is returned as it is.
 */
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
      // As Alchemy's own `getByName`, on the jurisdiction's namespace. No Cloud class declares
      // RPC error classes for the stub to revive.
      getByName: (name, options) =>
        Cloudflare.makeRpcStub<Cloudflare.DurableObjectStub<Shape>>(
          namespace().getByName(name, options),
        ),
    } satisfies Cloudflare.DurableObject<Shape>;
  });
