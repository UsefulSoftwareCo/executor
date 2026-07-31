import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PACKAGE_URL = import.meta.resolve("@executor-js/host-cloudflare/package.json");
const HOST_ASSETS_DIR = fileURLToPath(new URL("./dist", HOST_PACKAGE_URL));
const HOST_WORKER_ENTRY = fileURLToPath(import.meta.resolve("@executor-js/host-cloudflare/worker"));

const WORKER_FIRST_ROUTES: string[] = [
  "/api/*",
  "/mcp",
  "/mcp/*",
  "/.well-known/*",
  "/v1",
  "/v1/*",
];

const namesForStage = (stage: string) => {
  const suffix = stage === "prod" ? "" : `-${stage}`;
  return {
    worker: `executor-cloudflare${suffix}`,
    database: `executor${suffix}`,
    bucket: `executor-blobs${suffix}`,
  };
};

const optionalString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined));

const hashAssetsDirectory = async (root: string): Promise<string> => {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        files.push(path);
      }
    }
  };
  await walk(root);

  const hash = createHash("sha256");
  for (const path of files) {
    const contents = await readFile(path);
    const relativePath = relative(root, path).split(sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
  }
  return hash.digest("hex");
};

export default Alchemy.Stack(
  "ExecutorCloudflare",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const names = namesForStage(stage);

    // Installation-specific values are explicit inputs rather than live vars.
    // In particular, EXECUTOR_SECRET_KEY must never be regenerated for an
    // existing D1 database: changing it would make stored credentials unreadable.
    const accessTeamDomain = yield* Config.string("ACCESS_TEAM_DOMAIN");
    const accessAud = yield* Config.string("ACCESS_AUD");
    const adminEmails = yield* Config.string("ADMIN_EMAILS");
    const organizationId = yield* Config.string("SELF_HOSTED_ORG_ID").pipe(
      Config.withDefault("default"),
    );
    const organizationName = yield* Config.string("SELF_HOSTED_ORG_NAME").pipe(
      Config.withDefault("Default"),
    );
    const organizationSlug = yield* optionalString("SELF_HOSTED_ORG_SLUG");
    const allowLocalNetwork = yield* optionalString("ALLOW_LOCAL_NETWORK");
    const publicSiteUrl = yield* optionalString("VITE_PUBLIC_SITE_URL");
    const executorSecretKey = yield* Config.redacted("EXECUTOR_SECRET_KEY");
    const assetsHash = yield* Effect.tryPromise(() => hashAssetsDirectory(HOST_ASSETS_DIR)).pipe(
      Effect.mapError(
        (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `Unable to hash built assets in ${HOST_ASSETS_DIR}`,
              cause,
            }),
          ),
      ),
    );

    const database = yield* Cloudflare.D1.Database("DB", {
      name: names.database,
    });
    const blobs = yield* Cloudflare.R2.Bucket("BLOBS", {
      name: names.bucket,
    });

    const worker = yield* Cloudflare.Worker("Worker", {
      name: names.worker,
      main: HOST_WORKER_ENTRY,
      compatibility: {
        date: "2025-04-01",
        flags: ["nodejs_compat"],
      },
      observability: { enabled: true },
      // Alchemy emits the required `ASSETS` fetcher binding whenever an assets
      // config is present; the binding name is fixed by the Worker provider.
      // Supplying a deterministic content hash also lets unchanged plans
      // converge instead of conservatively treating the directory as dirty.
      assets: {
        directory: HOST_ASSETS_DIR,
        hash: assetsHash,
        notFoundHandling: "single-page-application",
        runWorkerFirst: WORKER_FIRST_ROUTES,
      },
      env: {
        DB: database,
        BLOBS: blobs,
        // New local classes become SQLite-backed DOs. On first `--adopt`,
        // Alchemy matches foreign classes by binding name and reuses them when
        // these class names match the existing Wrangler deployment.
        MCP_SESSION: Cloudflare.DurableObject("MCP_SESSION", {
          className: "McpSessionDO",
        }),
        MCP_EXECUTION_OWNER: Cloudflare.DurableObject("MCP_EXECUTION_OWNER", {
          className: "McpExecutionOwnerDirectoryDO",
        }),
        ACCESS_TEAM_DOMAIN: accessTeamDomain,
        ACCESS_AUD: accessAud,
        ACCESS_NAME_CLAIM: "name",
        ACCESS_GROUPS_CLAIM: "groups",
        ADMIN_EMAILS: adminEmails,
        ENABLE_DEV_AUTH: "false",
        SELF_HOSTED_ORG_ID: organizationId,
        SELF_HOSTED_ORG_NAME: organizationName,
        ...(organizationSlug === undefined ? {} : { SELF_HOSTED_ORG_SLUG: organizationSlug }),
        ...(allowLocalNetwork === undefined ? {} : { ALLOW_LOCAL_NETWORK: allowLocalNetwork }),
        ...(publicSiteUrl === undefined ? {} : { VITE_PUBLIC_SITE_URL: publicSiteUrl }),
        EXECUTOR_SECRET_KEY: executorSecretKey,
      },
    });

    return {
      url: worker.url,
      workerName: worker.workerName,
      databaseName: database.databaseName,
      bucketName: blobs.bucketName,
    };
  }),
);
