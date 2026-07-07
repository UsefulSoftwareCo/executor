/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: out-of-band deploy-promotion CLI */

/**
 * Promote a specific, already-uploaded executor-cloud Worker version to a
 * chosen percentage of live traffic, using Cloudflare's staged
 * gradual-deployment model (`wrangler versions deploy`).
 *
 * This is the second half of the upload -> staged-promotion deploy flow
 * (see apps/cloud/DEPLOY.md and .github/workflows/deploy.yml). Merges upload a
 * version but route no traffic to it; this script promotes it deliberately.
 *
 * The version to promote is chosen EXPLICITLY, never inferred silently:
 *   --version <id>   promote exactly that version id (from
 *                    `wrangler versions list`). This is what advances an
 *                    existing canary: re-run at a higher --percent for the SAME
 *                    --version so you widen the version you already reviewed,
 *                    not whatever landed on main since.
 *   --version latest promote the most recently uploaded version. This is an
 *                    explicit opt-in for "promote what I just merged"; it is
 *                    NEVER the default, so advancing a rollout can never
 *                    accidentally promote unreviewed code.
 *
 * Percentage:
 *   --percent 100    promote the chosen version to 100% (full cutover).
 *   --percent 10     split traffic 10% chosen / 90% current-live version, for a
 *                    canary step. Re-run at a higher percentage (same version)
 *                    to advance; the DOs whose sessions land on the newly
 *                    promoted version restart, so keep early steps small and
 *                    watch telemetry between steps.
 *
 * IMPORTANT: a promotion that changes a Durable Object's assigned version
 * restarts that DO (validated empirically, DEPLOY.md experiments 3b/5). Stage
 * promotions to bound that blast radius.
 *
 * Reads no secrets beyond CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (already
 * in the CI env). Config is the generated dist config the build produced.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The generated dist config the build produced. Overridable via
// PROMOTE_CLOUD_CONFIG for testing against a non-prod worker.
const CONFIG = process.env.PROMOTE_CLOUD_CONFIG ?? "dist/server/wrangler.json";

// Target-worker guard: refuse to run against anything but executor-cloud unless
// the operator explicitly names the worker they expect via
// PROMOTE_CLOUD_ALLOW_NAME (for a non-prod worker). A promotion
// routes live traffic and restarts DOs, so a misconfigured config that points at
// the wrong worker must fail loudly, not promote the wrong thing. `--yes` does
// NOT bypass this: it only skips wrangler's own interactive confirmation.
const EXPECTED_WORKER_NAME = process.env.PROMOTE_CLOUD_ALLOW_NAME ?? "executor-cloud";
{
  let configName: unknown;
  try {
    configName = (JSON.parse(readFileSync(CONFIG, "utf8")) as { name?: unknown }).name;
  } catch (error) {
    throw new Error(
      `could not read wrangler config ${CONFIG} to verify the target worker: ${String(error)}`,
    );
  }
  if (configName !== EXPECTED_WORKER_NAME) {
    throw new Error(
      `refusing to promote: wrangler config ${CONFIG} targets worker ${JSON.stringify(configName)}, expected ${JSON.stringify(EXPECTED_WORKER_NAME)}. ` +
        `Set PROMOTE_CLOUD_ALLOW_NAME to override for a non-production worker.`,
    );
  }
}

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const percentRaw = argValue("--percent");
if (!percentRaw) {
  throw new Error("--percent is required (1-100)");
}
const percent = Number(percentRaw);
if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
  throw new Error(`--percent must be an integer 1-100, got: ${percentRaw}`);
}

// The version to promote is required and explicit: an id, or the literal
// `latest` to opt in to "promote the most recently uploaded version".
const versionArg = argValue("--version") ?? process.env.PROMOTE_VERSION;
if (!versionArg) {
  throw new Error(
    "--version is required: pass an explicit version id (from `wrangler versions list`), " +
      "or the literal `latest` to promote the most recently uploaded version.",
  );
}

const wrangler = (wranglerArgs: readonly string[]): string => {
  const result = spawnSync("bun", ["run", "wrangler", ...wranglerArgs], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${wranglerArgs.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
};

type VersionListEntry = {
  readonly id: string;
  readonly number: number;
  readonly metadata?: { readonly created_on?: string };
};
type DeploymentStatus = {
  readonly versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }>;
};

const versions = JSON.parse(
  wrangler(["versions", "list", "-c", CONFIG, "--json"]),
) as VersionListEntry[];
if (versions.length === 0) {
  throw new Error("no uploaded versions found");
}

// Resolve the target version EXPLICITLY. `latest` is an opt-in that sorts by
// version number (monotonic per upload) descending, since `versions list`
// order is not guaranteed. Any other value is treated as a version id and must
// match an uploaded version exactly, so a typo or a since-deleted id fails
// loudly rather than promoting the wrong version.
let target: VersionListEntry;
if (versionArg === "latest") {
  const sorted = [...versions].sort((a, b) => {
    if (a.number !== b.number) return b.number - a.number;
    const at = a.metadata?.created_on ?? "";
    const bt = b.metadata?.created_on ?? "";
    return bt.localeCompare(at);
  });
  target = sorted[0];
} else {
  const found = versions.find((v) => v.id === versionArg);
  if (!found) {
    throw new Error(
      `version ${versionArg} not found among uploaded versions. ` +
        `Run \`wrangler versions list -c ${CONFIG}\` to see valid ids, ` +
        "or pass `latest` to promote the most recent upload.",
    );
  }
  target = found;
}

// The version(s) currently serving live traffic, so a partial promotion holds
// the remainder on the current-live version rather than an arbitrary one.
const status = JSON.parse(
  wrangler(["deployments", "status", "-c", CONFIG, "--json"]),
) as DeploymentStatus;
// The version to hold the remainder of a partial promotion: the current-live
// version carrying the most traffic that is NOT the one we are promoting. If
// the only current version IS the target, there is nothing to split against.
const currentLive = [...status.versions]
  .filter((v) => v.version_id !== target.id)
  .sort((a, b) => b.percentage - a.percentage)[0]?.version_id;

if (target.id === currentLive && percent === 100) {
  console.log(`Version ${target.id} is already live at 100%; nothing to promote.`);
  process.exit(0);
}

const deployArgs = ["versions", "deploy", "-c", CONFIG, "--yes"];
if (percent === 100 || !currentLive || currentLive === target.id) {
  deployArgs.push(`${target.id}@100%`);
} else {
  // Staged split: target@percent, current-live@remainder.
  deployArgs.push(`${target.id}@${percent}%`, `${currentLive}@${100 - percent}%`);
}

console.log(`Promoting ${target.id} (version #${target.number}) at ${percent}%...`);
console.log(wrangler(deployArgs));
console.log("Done. Monitor telemetry, then re-run at a higher percentage to advance the rollout.");
