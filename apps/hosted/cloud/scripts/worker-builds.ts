/**
 * Build every budgeted Worker the way `alchemy deploy` does, without credentials or a deploy.
 *
 * The deploy enforces each Worker's upload budget inside its Rolldown build
 * (`src/infrastructure/worker-build.ts`), which also writes what the Worker uploads. This runs
 * that same build for `scripts/worker-sizes.ts`. A stage's name is compiled into every Worker and
 * only production reports to Sentry, so production and a pull request's preview build differently.
 *
 * The dashboard Worker bundles the site, so each stage's site is built first, with the
 * environment the stack's `Site` resource gives that stage's deploy.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { layerNonInteractive } from "alchemy/Interaction";
import { evalStack } from "alchemy/Stack";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { browserOnlySettings } from "../web/browser-only-settings.ts";
import { cloudWorkers } from "../alchemy.run.ts";
import { AppData } from "../src/infrastructure/app-data-worker.ts";
import AppPages from "../src/app-ui.ts";
import { Api } from "../src/main.ts";
import { previewSlug } from "../src/contracts/pr-preview-selection.ts";
import { McpServer } from "../src/infrastructure/mcp-server-worker.ts";
import { Marketing } from "../src/infrastructure/marketing-worker.ts";
import { productionStage, testStagePrefix } from "../src/infrastructure/stage.ts";
import { interactionFaultMarkers } from "../src/infrastructure/mcp-interaction-faults-local.ts";
import { uploadedModulesPlugin } from "../src/infrastructure/worker-build.ts";

interface WorkerProps {
  readonly main: string;
  readonly isExternal?: boolean;
  readonly exports?: Record<string, unknown>;
  readonly build?: { readonly output?: { readonly plugins?: ReadonlyArray<unknown> } };
}

/**
 * Alchemy bundles Workers with this function and these compatibility rules when it deploys. They
 * are not public exports, so they are loaded from the installed package: a renamed module fails
 * here instead of drifting from what the deploy builds.
 */
const alchemyEntry = import.meta.resolve("alchemy");
const alchemyModule = (name: string) =>
  import(
    new URL(`${name}${alchemyEntry.endsWith(".ts") ? ".ts" : ".js"}`, new URL("./", alchemyEntry))
      .href
  );
const {
  WorkerBundle,
}: {
  readonly WorkerBundle: Effect.Effect<
    {
      readonly build: (options: object) => Effect.Effect<
        {
          readonly files: ReadonlyArray<{
            readonly path: string;
            readonly content: string | Uint8Array;
          }>;
        },
        Error
      >;
    },
    never,
    FileSystem.FileSystem | Path.Path
  >;
} = await alchemyModule("Cloudflare/Workers/Sources/Rolldown");
const {
  getCompatibility,
}: {
  readonly getCompatibility: (props: WorkerProps) => { date: string; flags: Array<string> };
} = await alchemyModule("Cloudflare/Workers/Compatibility");

/**
 * Worker props read deploy configuration, but each value becomes a binding, not uploaded
 * JavaScript. These stand-ins only satisfy each setting's validation; this job holds no secrets
 * and never contacts Cloudflare or Sentry. They are read through Effect's configuration, not
 * set in the environment, so the site build sees only what the deploy passes it.
 */
const deployConfiguration = {
  NODE_ENV: "production",
  CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
  CLOUDFLARE_API_TOKEN: "unused",
  CLOUDFLARE_ZONE_ID: "00000000000000000000000000000000",
  BETTER_AUTH_URL: "https://v2.executor.sh",
  BETTER_AUTH_SECRET: "0".repeat(64),
  EXECUTOR_ENCRYPTION_KEY: "0".repeat(64),
  EXECUTOR_BUILD_VERSION: "0".repeat(40),
  EXECUTOR_APP_UI_BASE_URL: "https://executor.app",
  CLOUD_PLACEMENT_REGION: "aws:us-east-1",
  AUTUMN_SECRET_KEY: "am_sk_live_unused",
  AUTUMN_SERVER_URL: "https://api.useautumn.com",
  AXIOM_TOKEN: "unused",
  AXIOM_ORG_ID: "unused",
  PLANETSCALE_ORGANIZATION: "unused",
  PLANETSCALE_DATABASE_NAME: "unused",
  PLANETSCALE_CLUSTER_SIZE: "unused",
  PLANETSCALE_REGION: "unused",
  PLANETSCALE_API_TOKEN: "unused",
  PLANETSCALE_API_TOKEN_ID: "unused",
  GITHUB_CLIENT_ID: "unused",
  GITHUB_CLIENT_SECRET: "unused",
  GOOGLE_CLIENT_ID: "unused",
  GOOGLE_CLIENT_SECRET: "unused",
  OAUTH_PROXY_SECRET: "0".repeat(32),
  OAUTH_PROXY_PRODUCTION_URL: "https://executor.sh",
  CONTEXT_DEV_API_KEY: "unused",
  POSTHOG_PERSONAL_API_KEY: "unused",
  SENTRY_AUTH_TOKEN: "unused",
  AUTH_EMAIL_DOMAIN: "executor.sh",
  AUTH_EMAIL_PROVISION_SUBDOMAIN: "unused",
  AUTH_TRUSTED_ORIGINS: "https://executor.sh",
};

/** A stage whose deploy builds these Workers, with the configuration that deploy reads. */
export interface Target {
  readonly stage: string;
  readonly configuration: Readonly<Record<string, string>>;
}

/** Production reports to Sentry and PostHog, so its site build injects Sentry's release code. */
export const production: Target = {
  stage: productionStage,
  configuration: {
    ...deployConfiguration,
    // v1's WorkOS key and database run only on production; previews receive neither.
    V1_WORKOS_API_KEY: "unused",
    V1_PLANETSCALE_DATABASE_NAME: "unused",
    // Production requires the GitHub App's credentials; previews have no operator clients.
    EXECUTOR_OAUTH_GITHUB_CLIENT_ID: "unused",
    EXECUTOR_OAUTH_GITHUB_CLIENT_SECRET: "unused",
    // Evaluate the v1 import's production path too: it binds v1's blob bucket.
    CLOUD_V1_IMPORT: "on",
    V1_IMPORT_OPERATOR_TOKEN: "unused-unused-unused-unused-unused",
    // The import requires v1's ID for every first-party client production offers.
    V1_FIRST_PARTY_CLIENT_IDS: JSON.stringify({ github: "unused" }),
    SENTRY_ENABLED: "true",
    POSTHOG_ENABLED: "true",
    SENTRY_URL: "https://sentry.io",
  },
};

/**
 * A pull request's preview reports to neither, as its workflow sets neither switch. It is a
 * retained test stage on a Neon database, as `bun run test-stage deploy` gives it.
 */
export const preview = (number: number): Target => ({
  stage: `${testStagePrefix}${previewSlug(number)}`,
  configuration: {
    ...deployConfiguration,
    TEST_STAGE_DATABASE_PROVIDER: "neon",
    TEST_STAGE_RETENTION: "retained",
    TEST_STAGE_BACKGROUND: "active",
    TEST_STAGE_EXPIRES_AT: "",
    TEST_STAGE_DOMAIN: "executor.engineering",
    TEST_STAGE_DATABASE: "unused",
    TEST_STAGE_DATABASE_ADMIN_URL: "postgres://unused@localhost/unused",
    TEST_STAGE_NEON_PROJECT_ID: "unused",
    NEON_API_KEY: "unused",
    EXECUTOR_APP_DOMAIN_ZONE: "executor.app",
    EXECUTOR_APP_UI_BASE_URL: `https://${previewSlug(number)}.executor.app`,
  },
});

/**
 * Stand-ins for the site settings the deploy reads from the Sentry and PostHog stacks, which this
 * job cannot read. Each passes the site build's validation, and none reaches the dashboard
 * Worker's code: its server build leaves out browser-only settings, `PUBLIC_` settings belong to
 * the marketing and docs builds, and Sentry's organization and project only address uploads.
 */
const otherStackSettings = {
  VITE_SENTRY_DSN: "https://0@o0.ingest.us.sentry.io/0",
  PUBLIC_SENTRY_DSN: "https://0@o0.ingest.us.sentry.io/0",
  VITE_SENTRY_TUNNEL: "/api/0000000000000000/submit",
  PUBLIC_SENTRY_TUNNEL: "/api/0000000000000000/submit",
  VITE_POSTHOG_KEY: "phc_unused",
  PUBLIC_POSTHOG_KEY: "phc_unused",
  VITE_POSTHOG_PATH: "/api/0000000000000000",
  PUBLIC_POSTHOG_PATH: "/api/0000000000000000",
  VITE_POSTHOG_HOST: "https://posthog.invalid",
  PUBLIC_POSTHOG_HOST: "https://posthog.invalid",
  SENTRY_ORG: "unused",
  SENTRY_PROJECT: "unused",
} satisfies Partial<
  Record<
    (typeof browserOnlySettings)[number] | `PUBLIC_${string}` | "SENTRY_ORG" | "SENTRY_PROJECT",
    string
  >
>;

class SiteBuildFailed extends Schema.TaggedError<SiteBuildFailed>()("SiteBuildFailed", {
  message: Schema.String,
}) {}

/** The Worker resources whose build enforces an upload budget, declared as the stack declares them. */
const budgetedWorkers = Alchemy.Stack(
  "executor-next-hosted",
  {
    // Declaring resources needs only the providers for their types; nothing is planned or applied.
    providers: Layer.mergeAll(Cloudflare.providers(), Command.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    yield* Api;
    yield* AppData;
    yield* AppPages;
    yield* McpServer;
    yield* Marketing;
  }).pipe(Effect.provide(cloudWorkers)),
);

const hasUploadBudget = (props: WorkerProps) =>
  props.build?.output?.plugins?.some(
    (plugin) =>
      typeof plugin === "object" &&
      plugin !== null &&
      "name" in plugin &&
      plugin.name === uploadedModulesPlugin,
  ) ?? false;

interface SiteProps {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

/**
 * Run the stage's `Site` build as Alchemy's `Command.Build` does: its command and directory, with
 * its environment over this process's. The deploy's job also exports the build version.
 */
const buildSite = (props: SiteProps, buildVersion: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env: Record<string, string> = { EXECUTOR_BUILD_VERSION: buildVersion };
    for (const [name, value] of Object.entries(props.env ?? {})) {
      if (value === undefined) continue;
      if (Output.isOutput(value)) {
        const standIn = new Map<string, string>(Object.entries(otherStackSettings)).get(name);
        if (standIn === undefined)
          return yield* new SiteBuildFailed({
            message:
              `The site setting ${name} comes from another stack, which this check cannot read. ` +
              "Give it a stand-in in scripts/worker-builds.ts if it stays out of the dashboard " +
              "Worker's code, as web/browser-only-settings.ts does for browser settings.",
          });
        // Set, as in the deploy, so the browser build splits its chunks the same way.
        env[name] = standIn;
        continue;
      }
      env[name] = String(Redacted.isRedacted(value) ? Redacted.value(value) : value);
    }
    const [command = "", ...args] = props.command.split(" ");
    const code = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        cwd: path.resolve(props.cwd ?? "."),
        env,
        extendEnv: true,
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (Number(code) !== 0)
      return yield* new SiteBuildFailed({
        message: `${props.command} exited with status ${code}`,
      });
  });

/**
 * Build the stage's site, then each budgeted Worker, and return what failed. A Worker over
 * budget still writes its upload before failing.
 */
export const buildWorkers = (target: Target) =>
  evalStack(
    budgetedWorkers,
    (stack) =>
      Effect.gen(function* () {
        const site = Object.values(stack.resources).find(
          (resource) => resource.Type === "Command.Build" && resource.LogicalId === "Site",
        );
        if (site === undefined)
          return yield* new SiteBuildFailed({ message: "The stack declares no Site build" });
        yield* buildSite(site.Props as SiteProps, deployConfiguration.EXECUTOR_BUILD_VERSION);
        const bundler = yield* WorkerBundle;
        const failures: Array<string> = [];
        for (const resource of Object.values(stack.resources)) {
          const props = resource.Props as WorkerProps | undefined;
          if (resource.Type !== "Cloudflare.Worker" || props === undefined) continue;
          if (!hasUploadBudget(props)) continue;
          // The same call Alchemy's Worker provider makes for a Rolldown-built Worker.
          const exit = yield* Effect.exit(
            bundler.build({
              id: resource.LogicalId,
              main: props.main,
              compatibility: getCompatibility(props),
              entry: props.isExternal
                ? { kind: "external" }
                : { kind: "effect", exports: props.exports ?? {} },
              stack: { name: stack.name, stage: stack.stage },
              extraOptions: props.build,
            }),
          );
          if (Exit.isFailure(exit)) {
            failures.push(
              `${target.stage} ${resource.LogicalId}: ${Cause.pretty(exit.cause).split("\n")[0]}`,
            );
            continue;
          }
          for (const file of exit.value.files) {
            const content =
              typeof file.content === "string"
                ? file.content
                : new TextDecoder().decode(file.content);
            for (const text of interactionFaultMarkers)
              if (content.includes(text))
                failures.push(
                  `${target.stage} ${resource.LogicalId}: ${file.path} contains the local test ` +
                    `hook text "${text}", which only an \`alchemy dev\` build may bundle`,
                );
          }
        }
        return failures;
      }),
    { stage: target.stage },
  ).pipe(
    Effect.provide(
      ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: target.configuration }), {
        asPrimary: true,
      }),
    ),
    provideFreshArtifactStore,
    Effect.provide(Layer.mergeAll(layerNonInteractive(), Alchemy.localState())),
    Effect.provide(AlchemyContextLive),
  );
