import { Context, Effect, Logger, type Layer } from "effect";
import { HttpRouter } from "effect/http";

export const toRequestHttpEffect = <A, E, R>(appLayer: Layer.Layer<A, E, R>) => {
  const build = HttpRouter.toHttpEffect(appLayer);
  return Effect.updateContext(build, (context: Context.Context<Effect.Services<typeof build>>) =>
    Context.omit(Logger.CurrentLoggers)(context),
  );
};
