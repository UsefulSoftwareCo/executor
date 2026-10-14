/** Cloud reaches each app's data supervisor through its Durable Object namespace. */
import { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { evaluatedDeclarations } from "@executor-js/sdk/core";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Run `effect` with the current trace's ID, which the supervisor keeps when this call wakes it, so
 * a later cache command of the same request knows the request paid for the wake.
 */
const traced = <A, E, R>(effect: (trace: string | undefined) => Effect.Effect<A, E, R>) =>
  Effect.option(Effect.currentSpan).pipe(
    Effect.flatMap((span) =>
      effect(Option.getOrUndefined(Option.map(span, (span) => span.traceId))),
    ),
  );

export const durableDeclarations = (databases: Cloudflare.DurableObject<AppDataSupervisor>) =>
  evaluatedDeclarations((app, command) =>
    traced((trace) =>
      databases
        .getByName(app)
        .evaluated(command, trace)
        .pipe(Effect.provide(RuntimeContext.phantom)),
    ),
  );
