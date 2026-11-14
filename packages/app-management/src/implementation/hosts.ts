/**
 * Which host a client command talks to. `--host` wins, then EXECUTOR_HOST, then the host signed in
 * to last; with none of them, the command uses the local background Executor.
 */
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { Flag } from "effect/cli";
import { hostedExecutorOrigin } from "@executor-js/sdk/core";
import { LoginFailed, ToolsSignInRequired } from "../client-error.ts";
import { RegistryOrigin, mcpResource, rememberedHost, toolsSession } from "./node-auth.ts";

/** The local Executor that commands use when no host is named or remembered. */
export interface LocalServer {
  readonly url: string;
  /** Sent as the local API key. */
  readonly token: Redacted.Redacted<string>;
}

/** `--host`, falling back to EXECUTOR_HOST. The remembered host is read by {@link namedHost}. */
export const hostFlag = Flag.String("host").pipe(
  Flag.withDescription(
    `Executor origin, such as ${hostedExecutorOrigin}. Defaults to EXECUTOR_HOST, then the host you signed in to last, then the local background Executor, which starts if needed`,
  ),
  Flag.withFallbackConfig(Config.String("EXECUTOR_HOST")),
  Flag.optional,
);

/** The host `--host` or EXECUTOR_HOST names, or else the one signed in to last. */
export const namedHost = (flag: Option.Option<string>) =>
  Option.isSome(flag) ? Effect.succeed(flag) : rememberedHost;

const loopback = (origin: string) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);

/**
 * Where tool commands send MCP requests, and the bearer each request carries. A tools sign-in
 * refreshes inside `token`, so a long command or `executor mcp` keeps a current one.
 */
export interface ToolsTarget<E = never> {
  /** The host the command resolved, for messages. */
  readonly host: string;
  /** The MCP endpoint. */
  readonly url: string;
  readonly token: Effect.Effect<Redacted.Redacted<string>, E>;
  /** Whether this is the local Executor rather than a named host. */
  readonly local: boolean;
}

/**
 * Resolve the tool commands' host and credential. A named host uses a pasted
 * EXECUTOR_ACCESS_TOKEN, EXECUTOR_API_KEY for a loopback server, or the tools sign-in, in that
 * order, as app commands do. Without a host, the local server's key; `fresh` resolves the local
 * server again for every request, so a long-running relay follows a restarted server's password.
 */
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
