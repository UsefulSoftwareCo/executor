/**
 * Build every budgeted Worker the way `alchemy deploy` does and report what each uploads.
 *
 * The deploy enforces each Worker's upload budget inside its Rolldown build
 * (`src/infrastructure/worker-build.ts`). This runs that same build in the check job, without
 * credentials or a deploy, so a pull request learns its sizes in minutes instead of when its
 * preview or the production deploy fails. It builds production, and with `--preview` the pull
 * request's preview stage too: the stage name is compiled into every Worker, and only production
 * reports to Sentry. With `--base`, each Worker is compared with main's uploads, and the packages
 * and files that grew are named.
 *
 *   bun run hosted:cloud:worker-sizes [--preview <pull request number>] [--base <directory>]
 *
 * The dashboard Worker bundles the site, so each stage's site is built first, with the
 * environment the stack's `Site` resource gives that stage's deploy.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
  Config,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { browserOnlySettings } from "../web/browser-only-settings.ts";
import { cloudWorkers } from "../alchemy.run.ts";
import AppPages from "../src/app-ui.ts";
import { Api } from "../src/main.ts";
import { previewSlug } from "../src/contracts/pr-preview.ts";
import { McpServer } from "../src/infrastructure/mcp-server-worker.ts";
import { Marketing } from "../src/infrastructure/marketing-worker.ts";
import { productionStage, testStagePrefix } from "../src/infrastructure/stage.ts";
import { uploadedModulesPlugin } from "../src/infrastructure/worker-build.ts";
import {
  packageOf,
  workerUploadDirectory,
  type WorkerUpload,
} from "../src/infrastructure/worker-upload.ts";

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
    { readonly build: (options: object) => Effect.Effect<unknown, Error> },
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
  V1_WORKOS_API_KEY: "unused",
  V1_MEMBERSHIP_CHECK_SINCE: "2026-01-01T00:00:00Z",
  POSTHOG_PERSONAL_API_KEY: "unused",
  SENTRY_AUTH_TOKEN: "unused",
  AUTH_EMAIL_DOMAIN: "executor.sh",
  AUTH_EMAIL_PROVISION_SUBDOMAIN: "unused",
  AUTH_TRUSTED_ORIGINS: "https://executor.sh",
};

/** A stage whose deploy builds these Workers, with the configuration that deploy reads. */
interface Target {
  readonly stage: string;
  readonly configuration: Readonly<Record<string, string>>;
}

/** Production reports to Sentry and PostHog, so its site build injects Sentry's release code. */
const production: Target = {
  stage: productionStage,
  configuration: {
    ...deployConfiguration,
    SENTRY_ENABLED: "true",
    POSTHOG_ENABLED: "true",
    SENTRY_URL: "https://sentry.io",
  },
};

/**
 * A pull request's preview reports to neither, as its workflow sets neither switch. It is a
 * retained test stage on a Neon database, as `bun run test-stage deploy` gives it.
 */
const preview = (number: number): Target => ({
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

class WorkerSizesFailed extends Schema.TaggedError<WorkerSizesFailed>()("WorkerSizesFailed", {
  message: Schema.String,
}) {}

/** Below this share of its budget left, a Worker is flagged before pull requests start failing. */
const lowHeadroom = 0.05;

const WorkerUploadSchema = Schema.Struct({
  worker: Schema.String,
  bytes: Schema.Number,
  budget: Schema.Number,
  sources: Schema.Record(Schema.String, Schema.Number),
});

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
          return yield* new WorkerSizesFailed({
            message:
              `The site setting ${name} comes from another stack, which this check cannot read. ` +
              "Give it a stand-in in scripts/worker-sizes.ts if it stays out of the dashboard " +
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
      return yield* new WorkerSizesFailed({
        message: `${props.command} exited with status ${code}`,
      });
  });

/**
 * Build the stage's site, then each budgeted Worker; a Worker over budget still writes its
 * upload before failing.
 */
const buildWorkers = (target: Target) =>
  evalStack(
    budgetedWorkers,
    (stack) =>
      Effect.gen(function* () {
        const site = Object.values(stack.resources).find(
          (resource) => resource.Type === "Command.Build" && resource.LogicalId === "Site",
        );
        if (site === undefined)
          return yield* new WorkerSizesFailed({ message: "The stack declares no Site build" });
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
          if (Exit.isFailure(exit))
            failures.push(
              `${target.stage} ${resource.LogicalId}: ${Cause.pretty(exit.cause).split("\n")[0]}`,
            );
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
  );

const readUploads = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(directory))) return new Map<string, WorkerUpload>();
    const uploads = new Map<string, WorkerUpload>();
    for (const file of (yield* fs.readDirectory(directory)).toSorted()) {
      if (!file.endsWith(".json")) continue;
      const upload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerUploadSchema))(
        yield* fs.readFileString(path.join(directory, file)),
      );
      uploads.set(upload.worker, upload);
    }
    return uploads;
  });

/**
 * Name a file the same way in every build: Bun installs packages under
 * `node_modules/.bun/<name>@<version>/`, and the site build adds a content hash to each asset.
 */
const sourceFile = (source: string) =>
  source
    .replace(/node_modules\/\.bun\/[^/]+\/node_modules\//, "node_modules/")
    .replace(/(\/dist\/server\/assets\/.+)-[\w-]{8}\.js$/, "$1.js");

const bytes = (value: number) => value.toLocaleString("en-US");
const signed = (value: number) => `${value > 0 ? "+" : ""}${bytes(value)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** The entries whose bytes changed most between two attributions, largest change first. */
const changes = (
  current: Readonly<Record<string, number>>,
  base: Readonly<Record<string, number>>,
  key: (source: string) => string,
) => {
  const totals = new Map<string, number>();
  for (const [source, size] of Object.entries(current))
    totals.set(key(source), (totals.get(key(source)) ?? 0) + size);
  for (const [source, size] of Object.entries(base))
    totals.set(key(source), (totals.get(key(source)) ?? 0) - size);
  return [...totals]
    .filter(([, delta]) => delta !== 0)
    .toSorted((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
};

const table = (
  heading: string,
  rows: ReadonlyArray<readonly [string, number]>,
  format: (size: number) => string = signed,
) =>
  rows.length === 0
    ? []
    : [
        `| ${heading} | Bytes |`,
        "|---|---:|",
        ...rows.map(([name, size]) => `| \`${name}\` | ${format(size)} |`),
        "",
      ];

/** Each Worker's larger build decides its headroom; a preview can fail where production passes. */
interface Measured {
  readonly worker: string;
  readonly budget: number;
  readonly bytes: number;
  readonly stages: ReadonlyArray<string>;
}

const report = (
  uploads: ReadonlyMap<string, WorkerUpload>,
  previewBuild:
    | { readonly stage: string; readonly uploads: ReadonlyMap<string, WorkerUpload> }
    | undefined,
  base: ReadonlyMap<string, WorkerUpload> | undefined,
  failures: ReadonlyArray<string>,
) => {
  const measured: Array<Measured> = [...uploads.values()].map((upload) => {
    const previewBytes = previewBuild?.uploads.get(upload.worker)?.bytes ?? 0;
    const bytes = Math.max(upload.bytes, previewBytes);
    return {
      worker: upload.worker,
      budget: upload.budget,
      bytes,
      stages: [
        ...(upload.bytes === bytes ? [productionStage] : []),
        ...(previewBuild !== undefined && previewBytes === bytes ? [previewBuild.stage] : []),
      ],
    };
  });
  const over = measured.filter((worker) => worker.bytes > worker.budget);
  const low = measured.filter(
    (worker) =>
      worker.bytes <= worker.budget && worker.budget - worker.bytes < worker.budget * lowHeadroom,
  );
  const lines = [
    "## Worker upload sizes",
    "",
    "Built as `alchemy deploy` builds them, against the budgets in " +
      "`apps/hosted/cloud/src/infrastructure/worker-build.ts`. Headroom is for the larger build." +
      (base === undefined
        ? " Main's sizes for this base were not available, so no change is shown."
        : ""),
    "",
    previewBuild === undefined
      ? `| Worker | \`${productionStage}\` | Change from main | Budget | Headroom |`
      : `| Worker | \`${productionStage}\` | \`${previewBuild.stage}\` | Change from main | Budget | Headroom |`,
    previewBuild === undefined ? "|---|---:|---:|---:|---:|" : "|---|---:|---:|---:|---:|---:|",
  ];
  for (const worker of measured) {
    const upload = uploads.get(worker.worker);
    const before = base?.get(worker.worker);
    const previewUpload = previewBuild?.uploads.get(worker.worker);
    const left = worker.budget - worker.bytes;
    const flag = left < 0 ? " **over budget**" : left < worker.budget * lowHeadroom ? " low" : "";
    lines.push(
      `| ${worker.worker} | ${upload === undefined ? "n/a" : bytes(upload.bytes)} | ` +
        (previewBuild === undefined
          ? ""
          : `${previewUpload === undefined ? "n/a" : bytes(previewUpload.bytes)} | `) +
        `${before === undefined || upload === undefined ? "n/a" : signed(upload.bytes - before.bytes)} | ` +
        `${bytes(worker.budget)} | ${signed(left)} (${percent(left / worker.budget)})${flag} |`,
    );
  }
  lines.push("");
  for (const upload of uploads.values()) {
    const before = base?.get(upload.worker);
    if (before === undefined || before.bytes === upload.bytes) continue;
    lines.push(
      `### ${upload.worker}: ${signed(upload.bytes - before.bytes)} bytes`,
      "",
      ...table("Package", changes(upload.sources, before.sources, packageOf).slice(0, 10)),
      ...table("File", changes(upload.sources, before.sources, sourceFile).slice(0, 10)),
    );
  }
  if (over.length > 0 || low.length > 0)
    lines.push(
      "### Making room",
      "",
      "Cloudflare compiles every uploaded module when an isolate starts, whether or not it runs, so " +
        "each megabyte adds about 50 ms to every cold request. Budgets are not raised to fit a change. " +
        "A dynamic `import()` does not help: its chunk is still uploaded.",
      "",
      "- Move rarely used code to another Worker behind a service binding, as `dashboard`, " +
        "`formatter` and `mcp-server` do for the API Worker.",
      "- Serve large text or data as static assets or from storage instead of bundling it as JavaScript.",
      "- Remove duplicate copies of a package and import narrower entry points.",
      "",
    );
  for (const upload of uploads.values())
    lines.push(
      `<details><summary>${upload.worker}: largest packages</summary>`,
      "",
      ...table("Package", changes(upload.sources, {}, packageOf).slice(0, 15), bytes),
      "</details>",
      "",
    );
  if (failures.length > 0)
    lines.push("### Build failures", "", ...failures.map((failure) => `- ${failure}`), "");
  return { markdown: lines.join("\n"), over, low };
};

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* path.fromFileUrl(workerUploadDirectory);
  const previewNumber = flag("--preview");
  if (previewNumber !== undefined && !/^[1-9][0-9]*$/.test(previewNumber))
    return yield* new WorkerSizesFailed({ message: `--preview takes a pull request number` });
  // Production builds last, so the uploads left in the directory are production's.
  const measure = (target: Target) =>
    Effect.gen(function* () {
      yield* fs.remove(directory, { recursive: true, force: true });
      const failures = yield* buildWorkers(target).pipe(
        provideFreshArtifactStore,
        Effect.provide(Layer.mergeAll(layerNonInteractive(), Alchemy.localState())),
      );
      return { stage: target.stage, uploads: yield* readUploads(directory), failures };
    });
  const previewBuild =
    previewNumber === undefined ? undefined : yield* measure(preview(Number(previewNumber)));
  const productionBuild = yield* measure(production);
  const failures = [...(previewBuild?.failures ?? []), ...productionBuild.failures];
  const baseDirectory = flag("--base");
  const base = baseDirectory === undefined ? undefined : yield* readUploads(baseDirectory);
  const { markdown, over, low } = report(
    productionBuild.uploads,
    previewBuild,
    base === undefined || base.size === 0 ? undefined : base,
    failures,
  );
  yield* Console.log(markdown);
  const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
  if (Option.isSome(summary))
    yield* fs.writeFileString(summary.value, `${markdown}\n`, { flag: "a" });
  for (const worker of over)
    yield* Console.log(
      `::error title=${worker.worker} Worker over its upload budget::${bytes(worker.bytes)} bytes on ${worker.stages.join(" and ")}, budget ${bytes(worker.budget)}. See the job summary for what grew.`,
    );
  for (const worker of low)
    yield* Console.log(
      `::warning title=${worker.worker} Worker near its upload budget::${bytes(worker.budget - worker.bytes)} bytes left on ${worker.stages.join(" and ")} (${percent((worker.budget - worker.bytes) / worker.budget)}).`,
    );
  if (failures.length > 0)
    return yield* new WorkerSizesFailed({
      message: `Worker builds failed: ${failures.join("; ")}`,
    });
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);
