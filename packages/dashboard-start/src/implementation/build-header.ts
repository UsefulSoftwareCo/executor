/** Server half of build change detection; the browser half is `build-change.ts`. */
import { Config, Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { buildHeader } from "../contracts/build.ts";

const withBuild = (build: string) => (response: HttpServerResponse.HttpServerResponse) => {
  // A quoted string, so any build name stays one metric description.
  const metric = `${buildHeader};desc=${JSON.stringify(build)}`;
  const timing = response.headers["server-timing"];
  return HttpServerResponse.setHeaders(response, {
    [buildHeader]: build,
    "server-timing": timing === undefined ? metric : `${timing}, ${metric}`,
  });
};

/**
 * Name this server's build on every response of the router it is provided to, documents included.
 * A server started without `EXECUTOR_BUILD_VERSION`, such as development, names none, and its
 * pages compare nothing.
 */
export const layerBuildHeader = HttpRouter.middleware(
  Effect.map(
    Config.String("EXECUTOR_BUILD_VERSION").pipe(Config.option, Effect.orDie),
    (build) =>
      <E, R>(response: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        Option.match(build, {
          onNone: () => response,
          onSome: (build) => Effect.map(response, withBuild(build)),
        }),
  ),
  { global: true },
);
