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
