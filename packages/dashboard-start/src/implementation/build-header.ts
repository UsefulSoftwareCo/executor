import { Config, Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { buildHeader } from "../contracts/build.ts";

const withBuild = (build: string) => (response: HttpServerResponse.HttpServerResponse) => {
  const metric = `${buildHeader};desc=${JSON.stringify(build)}`;
  const timing = response.headers["server-timing"];
  return HttpServerResponse.setHeaders(response, {
    [buildHeader]: build,
    "server-timing": timing === undefined ? metric : `${timing}, ${metric}`,
  });
};

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
