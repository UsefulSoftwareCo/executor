import { Config, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { Flag } from "effect/cli";
import { hostedExecutorOrigin } from "@executor-js/sdk/core";
import { LoginFailed, ToolsSignInRequired } from "../client-error.ts";
import { RegistryOrigin, mcpResource, rememberedHost, toolsSession } from "./node-auth.ts";

export interface LocalServer {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
}

export const hostFlag = Flag.String("host").pipe(
  Flag.withDescription(
    `Executor origin, such as ${hostedExecutorOrigin}. Defaults to EXECUTOR_HOST, then the host you signed in to last, then the local background Executor, which starts if needed`,
  ),
  Flag.withFallbackConfig(Config.String("EXECUTOR_HOST")),
  Flag.optional,
);

export const namedHost = (flag: Option.Option<string>) =>
  Option.isSome(flag) ? Effect.succeed(flag) : rememberedHost;

const loopback = (origin: string) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);

export interface ToolsTarget<E = never> {
  readonly host: string;
  readonly url: string;
  readonly token: Effect.Effect<Redacted.Redacted<string>, E>;
  readonly local: boolean;
}

export const toolsTarget = <E, R>(
  flag: Option.Option<string>,
  localServer: Effect.Effect<LocalServer, E, R> | undefined,
  options: { readonly fresh: boolean },
) =>
  Effect.gen(function* () {
    const target = (resolved: ToolsTarget<E | ToolsSignInRequired>) => resolved;
    const host = yield* namedHost(flag);
    if (Option.isNone(host)) {
      if (localServer === undefined) return yield* new ToolsSignInRequired({});
      const local = yield* localServer;
      const services = yield* Effect.context<R>();
      return target({
        host: local.url,
        url: `${local.url}/mcp`,
        token: options.fresh
          ? localServer.pipe(
              Effect.map(({ token }) => token),
              Effect.provideContext(services),
            )
          : Effect.succeed(local.token),
        local: true,
      });
    }
    const origin = host.value;
    if (!Schema.is(RegistryOrigin)(origin))
      return yield* new LoginFailed({ signIn: "mcp", reason: "host" });
    const pasted = yield* Config.Redacted("EXECUTOR_ACCESS_TOKEN").pipe(Config.option);
    if (Option.isSome(pasted))
      return target({
        host: origin,
        url: yield* mcpResource(origin).pipe(
          Effect.mapError(() => new LoginFailed({ signIn: "mcp", reason: "host" })),
        ),
        token: Effect.succeed(pasted.value),
        local: false,
      });
    const key = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
    if (Option.isSome(key) && loopback(origin))
      return target({
        host: origin,
        url: `${origin}/mcp`,
        token: Effect.succeed(key.value),
        local: false,
      });
    const signedIn = () => new ToolsSignInRequired({ host: origin });
    const session = yield* toolsSession(origin).pipe(Effect.mapError(signedIn));
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    return target({
      host: origin,
      url: Redacted.value(session).resource,
      token: toolsSession(origin).pipe(
        Effect.map((fresh) => Redacted.make(Redacted.value(fresh).accessToken)),
        Effect.mapError(signedIn),
        Effect.provideContext(services),
      ),
      local: false,
    });
  });
