import { HttpUrl } from "@executor-js/sdk/core";
import { Config, Effect, Option, Schema } from "effect";
import { accountOAuthStatePrefix } from "../contracts/edge-paths.ts";
import { stageAccountStatePrefix } from "../contracts/stage-account-state.ts";
import { cloudEmulators } from "../infrastructure/emulators.ts";
import { cloudHosts, type AccountCallbacks, type CloudHosts } from "../infrastructure/stage.ts";

const ProxyOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
      } catch {
        return false;
      }
    },
    {
      message:
        "The OAuth proxy's production URL must be an HTTP(S) origin without a trailing slash",
    },
  ),
);

const OAuthProxySettings = Schema.Struct({
  productionUrl: Schema.Option(ProxyOrigin),
  secret: Schema.Option(Schema.Redacted(Schema.String.check(Schema.isMinLength(32)))),
}).check(
  Schema.makeFilter((value) => Option.isSome(value.productionUrl) === Option.isSome(value.secret), {
    message: "Set the OAuth proxy's production URL and secret together, or set neither",
  }),
);

export const socialCallbackOrigin = (hosts: CloudHosts) =>
  Option.match(hosts.roles, {
    onNone: () => hosts.browser,
    onSome: (roles) => roles.edge,
  });

export const cloudOAuthProxy = Effect.gen(function* () {
  const emulators = yield* cloudEmulators;
  const names = Option.isSome(emulators)
    ? {
        productionUrl: "EXECUTOR_EMULATED_OAUTH_PROXY_PRODUCTION_URL",
        secret: "EXECUTOR_EMULATED_OAUTH_PROXY_SECRET",
      }
    : { productionUrl: "OAUTH_PROXY_PRODUCTION_URL", secret: "OAUTH_PROXY_SECRET" };
  const settings = yield* Config.all({
    productionUrl: Config.String(names.productionUrl).pipe(Config.option),
    secret: Config.Redacted(names.secret).pipe(Config.option),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OAuthProxySettings)), Effect.map(Option.all));
  return { names, settings };
});

export const cloudAccountSignIns = Effect.gen(function* () {
  const hosts = yield* cloudHosts;
  const { settings } = yield* cloudOAuthProxy;
  const production = Option.filter(
    Option.map(settings, (proxy) => proxy.productionUrl),
    (url) => url !== socialCallbackOrigin(hosts),
  );
  if (Option.isNone(production) || Option.isNone(hosts.accountCallbacks))
    return { callbacks: hosts.accountCallbacks, statePrefix: accountOAuthStatePrefix };
  const own = hosts.accountCallbacks.value;
  return {
    callbacks: Option.some<AccountCallbacks>({
      current: new URL("/api/oauth/callback", production.value).href,
      previous: [own.current, ...own.previous],
    }),
    statePrefix: stageAccountStatePrefix(hosts.browser),
  };
});

export const cloudAccountRedirectUri = Effect.gen(function* () {
  const accountSignIns = yield* cloudAccountSignIns;
  const configured = yield* Config.String("EXECUTOR_OAUTH_CALLBACK_URL").pipe(
    Config.option,
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Option(HttpUrl))),
  );
  if (Option.isNone(accountSignIns.callbacks)) return configured;
  if (Option.isSome(configured))
    return yield* Effect.die(
      new Error(
        "EXECUTOR_OAUTH_CALLBACK_URL is derived from the role hosts; remove it from this deployment",
      ),
    );
  return Option.some(HttpUrl.make(accountSignIns.callbacks.value.current));
});

export const isOAuthProxyProduction = (
  hosts: CloudHosts,
  proxy: Effect.Success<typeof cloudOAuthProxy>["settings"],
) => Option.exists(proxy, (settings) => settings.productionUrl === socialCallbackOrigin(hosts));
