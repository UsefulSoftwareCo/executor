/** Test stages are named `test-<slug>`. Each one derives its origin and owns generated secrets. */
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stage } from "alchemy/Stage";
import { singleResourceOrigin, type ResourceOrigins } from "@executor-js/hosted-server";
import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";

export const testStagePrefix = "test-";

/** The stage every push to `main` deploys. It serves real customers. */
export const productionStage = "v2";

/**
 * Production's API Worker script name, retained from the original edge binding. Keep the
 * existing Worker identity when the public site moves to its separate marketing gateway.
 */
export const productionApiWorkerName = "executor-next-hosted-api-v2-qs32brgjwvt7ytx4";

/** Slugs map one-to-one to the stage's logical database name. */
export const TestStageSlug = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(value), {
    message: "A test stage slug is 1-42 lowercase letters, digits and hyphens",
  }),
);

export interface TestStage {
  readonly name: string;
  readonly slug: string;
  /** The zone the stage's hostnames live in (`TEST_STAGE_DOMAIN`). */
  readonly domain: string;
  readonly origin: string;
}

/**
 * Provisioning receives the stage as a service and the deployed Worker reads Alchemy's plain
 * binding. Jobs and tests outside Alchemy have neither and use explicit configuration.
 */
export const stageName = Effect.serviceOption(Stage).pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(Option.some(stage)),
      onNone: () => Config.String("ALCHEMY_STAGE").pipe(Config.option),
    }),
  ),
);

/** Only stages with the prefix are test stages. Every other stage keeps its explicit configuration. */
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
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
      } catch {
        return false;
      }
    },
    { message: "BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash" },
  ),
);

/** The zone that serves production. See `product-zone.ts` for its certificate rule. */
export const productZone = "executor.sh";

/**
 * A hostname this stage's Worker serves, as a custom domain or a route. Each new custom domain in
 * the product zone orders a certificate that Cloudflare then serves for the apex, so only
 * production may serve a host in it.
 */
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

/** The public origin: derived from the stage name for test stages, configured everywhere else. */
export const cloudOrigin = testStage.pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(stage.origin),
      onNone: () =>
        Config.String("BETTER_AUTH_URL").pipe(Effect.flatMap(Schema.decodeUnknownEffect(Origin))),
    }),
  ),
);

/**
 * The hosts that each serve one part of the product beside the deployment origin
 * (`notes/cloud-domains.md`): `app.` the dashboard and sign-in, `mcp.` MCP and its discovery,
 * `api.` the API, its discovery and app webhooks.
 */
export const hostRoles = ["app", "mcp", "api"] as const;
export type HostRole = (typeof hostRoles)[number];

/** The origin of each role host, and the zone a deployed stage serves them from. */
export interface RoleHosts {
  readonly origins: { readonly [Role in HostRole]: string };
  /**
   * The origin v1's edge forwards from: `https://executor.sh` in production. A test stage's
   * forwarding Worker serves `edge.<slug>.<test domain>`; a local run's Worker serves it itself.
   */
  readonly edge: string;
  /** The domain the role hosts live under, and the passkey relying party. */
  readonly domain: string;
  /** None when the hosts come from `EXECUTOR_ROLE_HOSTS_DOMAIN`, which only local runs set. */
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

/**
 * The domain under which the role hosts live: `executor.sh` for production, the stage's own
 * hostname for a test stage (`mcp.<slug>.executor.engineering`), and `EXECUTOR_ROLE_HOSTS_DOMAIN`
 * elsewhere, which jobs outside Alchemy and local runs set. Unset there means no role hosts.
 */
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

/**
 * The role hosts' setting for a job that runs outside Alchemy, such as the migration job that
 * provisions their OAuth resources: it has no stage, so it reads `EXECUTOR_ROLE_HOSTS_DOMAIN`.
 */
export const roleHostsJobEnvironment = roleHostsDomain.pipe(
  Effect.map(
    Option.match({
      onNone: (): Record<string, string> => ({}),
      onSome: ({ domain }): Record<string, string> => ({ EXECUTOR_ROLE_HOSTS_DOMAIN: domain }),
    }),
  ),
);

/** The role hosts beside `deployment`, with its scheme and port. */
const roleHostsAt = (deployment: string) =>
  roleHostsDomain.pipe(
    Effect.tap((roles) =>
      // v1 serves `executor.sh`; production's deployment origin is `v2.executor.sh` beside it.
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
          // Production's domain is `executor.sh` itself. A test stage or local run serves its
          // deployment at the domain, so its edge takes the `edge.` label under it.
          edge: hostname === domain ? at("edge") : `${protocol}//${domain}${suffix}`,
          domain,
          zone,
        };
      }),
    ),
  );

/** This deployment's role hosts, if it has them. */
export const cloudRoleHosts = Effect.flatMap(cloudOrigin, roleHostsAt);

/**
 * Which origin names the canonical MCP and API resources: the URLs pages show and the audience of
 * an authorization request that names no resource. `deployment` keeps `cloudOrigin`
 * (`v2.executor.sh`) canonical and serves the role hosts' resources beside it; `role` makes
 * `mcp.` and `api.` canonical. Every listed origin keeps accepting its own grants either way.
 */
export type CanonicalResourceOrigin = "deployment" | "role";

/** Ship 6 of `notes/cloud-domains.md` makes `mcp.` and `api.` canonical. */
export const canonicalResourceOrigin: CanonicalResourceOrigin = "role";

/**
 * Where connected-account sign-ins return when the deployment has role hosts: the `redirect_uri`
 * every sign-in sends, the client metadata document lists and dynamic client registration
 * registers. `deployment` is `<deployment origin>/api/oauth/callback` (`v2.executor.sh`), which
 * every OAuth client registered so far names. `edge` is the permanent `executor.sh` callback, which
 * v1's edge forwards by the state prefix. Both bounce to the browser origin's callback page.
 */
export type AccountCallbackOrigin = "deployment" | "edge";

/**
 * Stays `deployment` until each OAuth client's registered redirect URIs are stored, so a sign-in
 * names `executor.sh` only through a client that lists it (`notes/cloud-domains.md`, Pending).
 */
export const accountCallbackOrigin: AccountCallbackOrigin = "deployment";

/** The resource origins for a deployment origin, its role hosts and the canonical choice. */
const resourceOriginsFor = (
  canonical: CanonicalResourceOrigin,
  deployment: string,
  roles: Option.Option<RoleHosts>,
): ResourceOrigins => {
  if (Option.isNone(roles)) return singleResourceOrigin(deployment);
  const { mcp, api } = roles.value.origins;
  switch (canonical) {
    case "deployment":
      return { mcp: [deployment, mcp], api: [deployment, api] };
    case "role":
      return { mcp: [mcp, deployment], api: [api, deployment] };
  }
};

/**
 * Which host serves the dashboard and sign-in when the deployment has role hosts
 * (`CLOUD_BROWSER_ORIGIN`): `app` (`app.executor.sh`, the cutover, and the default) or
 * `deployment` (`v2.executor.sh`). `deployment` is the rollback switch of
 * `notes/cloud-domains.md`: it moves only the browser origin back. The role hosts, the issuer on
 * the edge, the resource audiences and the edge's forwarding stay as they are, so clients that
 * adopted them keep working and grants issued either way still validate.
 */
export const BrowserOrigin = Schema.Literals(["app", "deployment"]);
export type BrowserOrigin = typeof BrowserOrigin.Type;

export const browserOriginSetting = Config.Literals(
  BrowserOrigin.literals,
  "CLOUD_BROWSER_ORIGIN",
).pipe(Config.withDefault<BrowserOrigin>("app"));

/**
 * Where one Cloud deployment serves each part of the product (`notes/cloud-domains.md`). Without
 * role hosts, as in local development and self-contained jobs, every field names the deployment
 * origin. With them:
 *
 * - `deployment` (`v2.executor.sh`) is the Worker's own domain. It keeps serving MCP, the API,
 *   discovery, Git, webhooks and callbacks; its browser pages redirect to `browser`.
 * - `browser` (`app.executor.sh`) serves the dashboard and sign-in. It is Better Auth's base URL,
 *   so sessions and every sign-in cookie are host-only there. `CLOUD_BROWSER_ORIGIN=deployment`
 *   puts it back on `deployment`; `app.` then redirects its pages there.
 * - `edge` (`executor.sh`) is the origin v1's edge forwards a fixed set of paths from. The
 *   identifiers clients and providers store live there: the issuer, the social sign-in and
 *   connected-account callbacks.
 * - `site` serves the site and its documentation: the edge with role hosts, whose site pages
 *   every other host redirects to, and the deployment origin without them.
 * - `issuer` is exact, without a trailing slash; its endpoints stay on `browser`.
 * - `gitOrigins` serve app Git remotes, canonical first: the edge, whose remote URLs never move,
 *   then the deployment origin, where earlier clones' remotes point.
 * - Passkeys use the role hosts' domain as their relying party, so a move of the dashboard
 *   between hosts under it, the rollback included, keeps them.
 */
export interface CloudHosts {
  readonly deployment: string;
  readonly browser: string;
  readonly roles: Option.Option<RoleHosts>;
  readonly site: string;
  readonly resourceOrigins: ResourceOrigins;
  readonly issuer: string;
  readonly gitOrigins: readonly [string, ...string[]];
  readonly passkey: { readonly rpId: string; readonly origin: string };
}

/** The host layout of a deployment at `deployment`, with its browser origin setting. */
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
          // WebAuthn accepts only a registrable domain as a parent relying party, so a local run
          // under `localhost` keeps its passkeys on the browser host itself.
          rpId: isLoopbackHostname(r.domain) ? new URL(browser).hostname : r.domain,
          origin: browser,
        }),
      }),
    } satisfies CloudHosts;
  });

/** This deployment's host layout. */
export const cloudHosts = Effect.flatMap(cloudOrigin, cloudHostsAt);

/** Where a deployment at `deployment` serves its MCP and API resources. */
export const resourceOriginsAt = (deployment: string) =>
  Effect.map(cloudHostsAt(deployment), (hosts) => hosts.resourceOrigins);

/** Where this deployment serves its MCP and API resources. */
export const cloudResourceOrigins = Effect.map(cloudHosts, (hosts) => hosts.resourceOrigins);

/**
 * API Worker props: `AUTH_RATE_LIMIT_SWITCH` is true only under `alchemy dev`, from
 * `AlchemyContext.dev`, so every deployed Worker gets `false`. Read it from the Worker
 * environment, never through `Config`: Alchemy binds each `Config` read during initialization
 * from the deploy's own environment, over these props.
 */
export const authRateLimitSwitchBindings = Effect.gen(function* () {
  return { AUTH_RATE_LIMIT_SWITCH: (yield* AlchemyContext).dev };
});

/**
 * Whether Better Auth's per-address limit applies. Every request a test runner sends comes from
 * one address, so automated environments may turn it off; no deployed stage outside them can:
 *
 * - Production (`v2`) always enforces it, whatever its configuration says.
 * - A deployed `test-e2e-*` stage turns it off unless `TEST_STAGE_AUTH_RATE_LIMIT=true`.
 * - Cloud dev turns it off for `TEST_STAGE_AUTH_RATE_LIMIT=false` on a loopback origin, as the
 *   e2e harness asks. `localRuntime` is the Worker's `AUTH_RATE_LIMIT_SWITCH`, which only
 *   `alchemy dev` sets, so no deploy configuration reaches this branch, a loopback
 *   `BETTER_AUTH_URL` included.
 * - Every other stage enforces it.
 *
 * `scripts/check-auth-rate-limit.ts` checks these rules over every combination.
 */
export const cloudAuthRateLimit = (localRuntime: boolean) =>
  Effect.gen(function* () {
    // Read on every stage, so Alchemy binds it into the local Worker; only the rules use it.
    const configured = yield* Config.Boolean("TEST_STAGE_AUTH_RATE_LIMIT").pipe(Config.option);
    if (Option.getOrUndefined(yield* stageName) === productionStage) return true;
    const stage = yield* testStage;
    if (Option.isSome(stage))
      return stage.value.slug.startsWith("e2e-") ? Option.getOrElse(configured, () => false) : true;
    if (!localRuntime || !isLoopbackHostname(new URL(yield* cloudOrigin).hostname)) return true;
    return Option.getOrElse(configured, () => true);
  });
