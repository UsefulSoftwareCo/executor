/**
 * Where each stack keeps its Alchemy state. The development stage is one person's machine and
 * keeps local state, as do the disposable e2e-* stages started by the local CI harness.
 * Local dev invocations also keep local state. Other deployed stages are shared: test stages so any machine or agent can update
 * or destroy them, and deployed stages such as `v2` so the deploy workflow and a laptop see the
 * same records. `scripts/migrate-state.ts` moves an existing local stage into the shared store.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer, Option } from "effect";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { stageName } from "./stage.ts";

export const localStages = new Set(["development"]);

export const stackState = Layer.unwrap(
  Effect.gen(function* () {
    const name = yield* stageName.pipe(Effect.orDie);
    const context = yield* AlchemyContext;
    return !context.dev &&
      Option.isSome(name) &&
      !localStages.has(name.value) &&
      !name.value.startsWith("e2e-")
      ? Cloudflare.state()
      : Alchemy.localState();
  }),
);
