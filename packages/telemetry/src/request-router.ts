/**
 * Build an HTTP router whose handlers log with the loggers of the request they serve.
 *
 * `HttpApiBuilder` keeps the context a group's routes are built in and provides it to every
 * handler call, over the request's own. A logger in that context would replace the request's:
 * a Cloudflare Worker builds its routes during initialization, whose context holds Alchemy's
 * console logger, so every record a handler wrote went to the console only and never reached the
 * log exporter the request's telemetry provides. Routes are therefore built without the loggers
 * of the context that builds them; each handler call keeps the loggers its request runs with.
 */
import { Context, Effect, Logger, type Layer } from "effect";
import { HttpRouter } from "effect/http";

/** `HttpRouter.toHttpEffect`, building the routes without the builder's loggers. */
export const toRequestHttpEffect = <A, E, R>(appLayer: Layer.Layer<A, E, R>) => {
  const build = HttpRouter.toHttpEffect(appLayer);
  return Effect.updateContext(build, (context: Context.Context<Effect.Services<typeof build>>) =>
    Context.omit(Logger.CurrentLoggers)(context),
  );
};
