import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stage } from "alchemy/Stage";
import { singleResourceOrigin, type ResourceOrigins } from "@executor-js/hosted-server";
import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";
import { TestStageSlug } from "../contracts/test-stage-lifetime.ts";

export const testStagePrefix = "test-";

export const productionStage = "v2";

export const productionApiWorkerName = "executor-next-hosted-api-v2-qs32brgjwvt7ytx4";

export interface TestStage {
  readonly name: string;
  readonly slug: string;
  readonly domain: string;
  readonly origin: string;
}

export const stageName = Effect.serviceOption(Stage).pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(Option.some(stage)),
      onNone: () => Config.String("ALCHEMY_STAGE").pipe(Config.option),
    }),
  ),
);

export const testStage = Effect.gen(function* () {
  const name = yield* stageName;
  if (Option.isNone(name) || !name.value.startsWith(testStagePrefix))
    return Option.none<TestStage>();
  const slug = yield* Schema.decodeUnknownEffect(TestStageSlug)(
    name.value.slice(testStagePrefix.length),
  );
  const domain = yield* Config.String("TEST_STAGE_DOMAIN").pipe(
    Config.withDefault("executor.engineering"),
  );
  return Option.some<TestStage>({
    name: name.value,
    slug,
    domain,
    origin: `https://${slug}.${domain}`,
  });
});

const Origin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" ||
            (url.protocol === "http:" && isLoopbackHostname(url.hostname))) &&
          url.origin === value
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "BETTER_AUTH_URL must be an HTTPS origin without a trailing slash. Only Cloud " +
        "development on a loopback host may use plain HTTP.",
    },
  ),
);

export const productZone = "executor.sh";

export const customDomain = (origin: URL) =>
  Effect.gen(function* () {
    const hostname = origin.hostname;
    const stage = Option.getOrUndefined(yield* stageName);
    if (
      (hostname === productZone || hostname.endsWith(`.${productZone}`)) &&
      stage !== productionStage
    )
      return yield* Effect.die(
        new Error(
          `Stage ${stage ?? "<unset>"} cannot use ${hostname}: only ${productionStage} may add a ` +
            `host in ${productZone}. Use a test-stage domain instead.`,
        ),
      );
    return hostname;
  });

export const cloudOrigin = testStage.pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(stage.origin),
      onNone: () =>
        Config.String("BETTER_AUTH_URL").pipe(Effect.flatMap(Schema.decodeUnknownEffect(Origin))),
    }),
  ),
);

export const hostRoles = ["app", "mcp", "api"] as const;
export type HostRole = (typeof hostRoles)[number];

export interface RoleHosts {
  readonly origins: { readonly [Role in HostRole]: string };
  /**
   * The origin v1's edge forwards from: `https://executor.sh` in production. A test stage's
   * forwarding Worker serves `edge.<slug>.<test domain>`; a local run's Worker serves it itself.
   */
  readonly edge: string;
  /**
   * The host v1's AuthKit served its sign-in from: `https://signin.executor.sh` in production,
   * `signin.` under the stage's domain elsewhere. v2 answers it so that MCP clients holding
   * AuthKit's sign-in move to v2 (`notes/v1-shutdown.md`, "AuthKit").
   */
  readonly authKit: string;
  readonly domain: string;
  readonly zone: Option.Option<string>;
}

const RoleHostsDomain = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        return new URL(`https://mcp.${value}`).hostname === `mcp.${value}`;
      } catch {
        return false;
      }
    },
    { message: "EXECUTOR_ROLE_HOSTS_DOMAIN must be a hostname, such as localhost" },
  ),
);

export const roleHostsDomain = Effect.gen(function* () {
  if (Option.getOrUndefined(yield* stageName) === productionStage)
    return Option.some({ domain: productZone, zone: Option.some(productZone) });
  const stage = yield* testStage;
  if (Option.isSome(stage))
    return Option.some({
      domain: `${stage.value.slug}.${stage.value.domain}`,
      zone: Option.some(stage.value.domain),
    });
  const configured = yield* Config.String("EXECUTOR_ROLE_HOSTS_DOMAIN").pipe(Config.option);
  if (Option.isNone(configured)) return Option.none();
  const domain = yield* Schema.decodeUnknownEffect(RoleHostsDomain)(configured.value);
  return Option.some({ domain, zone: Option.none<string>() });
});

export const roleHostsJobEnvironment = roleHostsDomain.pipe(
  Effect.map(
    Option.match({
      onNone: (): Record<string, string> => ({}),
      onSome: ({ domain }): Record<string, string> => ({ EXECUTOR_ROLE_HOSTS_DOMAIN: domain }),
    }),
  ),
);

const roleHostsAt = (deployment: string) =>
  roleHostsDomain.pipe(
    Effect.tap((roles) =>
      Option.isSome(roles) &&
      roles.value.domain === productZone &&
      new URL(deployment).hostname === productZone
        ? Effect.die(
            new Error(`BETTER_AUTH_URL must be production's deployment origin, not ${productZone}`),
          )
        : Effect.void,
    ),
    Effect.map(
      Option.map(({ domain, zone }): RoleHosts => {
        const { protocol, port, hostname } = new URL(deployment);
        const suffix = port === "" ? "" : `:${port}`;
        const at = (label: string) => `${protocol}//${label}.${domain}${suffix}`;
        return {
          origins: { app: at("app"), mcp: at("mcp"), api: at("api") },
          edge: hostname === domain ? at("edge") : `${protocol}//${domain}${suffix}`,
          authKit: at("signin"),
          domain,
          zone,
        };
      }),
    ),
  );

export const cloudRoleHosts = Effect.flatMap(cloudOrigin, roleHostsAt);

export type CanonicalResourceOrigin = "deployment" | "role";

export const canonicalResourceOrigin: CanonicalResourceOrigin = "role";

export interface AccountCallbacks {
  readonly current: string;
  readonly previous: readonly string[];
}

const accountCallbacksFor = (deployment: string, roles: Option.Option<RoleHosts>) =>
  Option.map(roles, (r): AccountCallbacks => ({
    current: new URL("/api/oauth/callback", r.edge).href,
    previous: [new URL("/api/oauth/callback", deployment).href],
  }));

const resourceOriginsFor = (
  canonical: CanonicalResourceOrigin,
  deployment: string,
  roles: Option.Option<RoleHosts>,
): ResourceOrigins => {
  if (Option.isNone(roles)) return singleResourceOrigin(deployment);
  const { mcp, api } = roles.value.origins;
  const legacyMcp = roles.value.edge;
  switch (canonical) {
    case "deployment":
      return { mcp: [deployment, mcp], api: [deployment, api], legacyMcp };
    case "role":
      return { mcp: [mcp, deployment], api: [api, deployment], legacyMcp };
  }
};

export const BrowserOrigin = Schema.Literals(["app", "deployment"]);
export type BrowserOrigin = typeof BrowserOrigin.Type;

export const browserOriginSetting = Config.Literals(
  BrowserOrigin.literals,
  "CLOUD_BROWSER_ORIGIN",
).pipe(Config.withDefault<BrowserOrigin>("app"));

export interface CloudHosts {
  readonly deployment: string;
  readonly browser: string;
  readonly roles: Option.Option<RoleHosts>;
  readonly site: string;
  readonly resourceOrigins: ResourceOrigins;
  readonly issuer: string;
  readonly gitOrigins: readonly [string, ...string[]];
  readonly passkey: { readonly rpId: string; readonly origin: string };
  readonly accountCallbacks: Option.Option<AccountCallbacks>;
  readonly sharedCookieDomain: Option.Option<string>;
}

export const cloudHostsAt = (deployment: string) =>
  Effect.gen(function* () {
    const roles = yield* roleHostsAt(deployment);
    const browserOrigin = yield* browserOriginSetting;
    const browser = Option.match(roles, {
      onNone: () => deployment,
      onSome: (r) => (browserOrigin === "app" ? r.origins.app : deployment),
    });
    return {
      deployment,
      browser,
      roles,
      site: Option.match(roles, { onNone: () => deployment, onSome: (r) => r.edge }),
      resourceOrigins: resourceOriginsFor(canonicalResourceOrigin, deployment, roles),
      issuer: `${Option.match(roles, { onNone: () => deployment, onSome: (r) => r.edge })}/api/auth`,
      gitOrigins: Option.match(roles, {
        onNone: () => [deployment] as const,
        onSome: (r) => [r.edge, deployment] as const,
      }),
      passkey: Option.match(roles, {
        onNone: () => ({ rpId: new URL(deployment).hostname, origin: deployment }),
        onSome: (r) => ({
          rpId: isLoopbackHostname(r.domain) ? new URL(browser).hostname : r.domain,
          origin: browser,
        }),
      }),
      accountCallbacks: accountCallbacksFor(deployment, roles),
      sharedCookieDomain: Option.flatMap(roles, (r) =>
        isLoopbackHostname(r.domain) ? Option.none() : Option.some(r.domain),
      ),
    } satisfies CloudHosts;
  });

export const cloudHosts = Effect.flatMap(cloudOrigin, cloudHostsAt);

export const resourceOriginsAt = (deployment: string) =>
  Effect.map(cloudHostsAt(deployment), (hosts) => hosts.resourceOrigins);

export const cloudResourceOrigins = Effect.map(cloudHosts, (hosts) => hosts.resourceOrigins);

export const authRateLimitSwitchBindings = Effect.gen(function* () {
  return { AUTH_RATE_LIMIT_SWITCH: (yield* AlchemyContext).dev };
});

export const removalRevocationBudgetBindings = Effect.gen(function* () {
  return { REMOVAL_REVOCATION_BUDGET_SWITCH: (yield* AlchemyContext).dev };
});

export const cloudOwnerRevocationBudget = (localRuntime: boolean) =>
  Effect.gen(function* () {
    const configured = yield* Config.Number("TEST_STAGE_REMOVAL_REVOCATION_BUDGET_MS").pipe(
      Config.option,
    );
    return localRuntime ? Option.getOrUndefined(configured) : undefined;
  });

export const cloudAuthRateLimit = (localRuntime: boolean) =>
  Effect.gen(function* () {
    const configured = yield* Config.Boolean("TEST_STAGE_AUTH_RATE_LIMIT").pipe(Config.option);
    if (Option.getOrUndefined(yield* stageName) === productionStage) return true;
    const stage = yield* testStage;
    if (Option.isSome(stage))
      return stage.value.slug.startsWith("e2e-") ? Option.getOrElse(configured, () => false) : true;
    if (!localRuntime || !isLoopbackHostname(new URL(yield* cloudOrigin).hostname)) return true;
    return Option.getOrElse(configured, () => true);
  });
