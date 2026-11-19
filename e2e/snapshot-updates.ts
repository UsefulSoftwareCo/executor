import { parseCLI } from "vitest/node";

/**
 * Whether a Vitest run in e2e/ may write snapshots. Vitest writes a missing or empty snapshot and
 * passes unless it decides it runs in CI, and the runner starts Vitest without `CI`
 * (e2e/sdk/suite.ts), so without this a scenario would write its own expected value in CI too.
 * Every Vitest config in e2e/ sets `update` from `snapshotUpdate`: a run writes and updates no
 * snapshot unless asked, so a missing, empty or changed snapshot fails. The runner's
 * `--update-snapshots` asks by setting `E2E_UPDATE_SNAPSHOTS=1`; both refuse to run in CI. Vitest's
 * own `-u` and `--update` override `update`, so in CI `snapshotUpdate` also refuses them, however a
 * suite was started (`bun run e2e:…`, `bunx vitest`, `node node_modules/vitest/vitest.mjs`).
 * snapshot-updates.spec.ts checks each config and each case.
 */
export const updateSnapshotsVariable = "E2E_UPDATE_SNAPSHOTS";

/** CI as `runSuite` and Vitest read it: GitHub Actions sets both. */
export const inCi = (env: Readonly<Record<string, string | undefined>>) =>
  Boolean(env.CI) || Boolean(env.GITHUB_ACTIONS);

export const ciRefusal =
  "Snapshots are recorded only on purpose, on a workstation: CI runs never write them. Record them locally with --update-snapshots and --test-name, read every changed line in git diff, then commit.";

export const unnamedRefusal =
  "--update-snapshots records only the scenarios --test-name names, so their changes can be read line by line.";

/**
 * Whether a --test-name names no scenario for --update-snapshots: empty, or only spaces, which as a
 * pattern match nearly every title. Any other pattern, `.*` included, is a deliberate choice.
 */
export const namesNoScenario = (name: string) => name.trim() === "";

/**
 * What Vitest's own update argument asks of the Vitest `argv` starts, read by Vitest's own parser
 * so every spelling it accepts counts (`-u`, `--update`, `--update=all`, `-u=all`, `--update false`,
 * which Vitest reads as `all`). Only no argument, `--no-update` and `--update none` write nothing.
 */
const vitestUpdate = (argv: ReadonlyArray<string>) => {
  const asked: unknown = parseCLI(["vitest", ...argv.slice(2)]).options.update;
  return asked === undefined || asked === false || asked === "none" ? undefined : asked;
};

/**
 * Vitest's `update` option: `none` unless `E2E_UPDATE_SNAPSHOTS=1` outside CI. In CI it also
 * refuses Vitest's own update argument in `argv`, which would override it.
 */
export const snapshotUpdate = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  argv: ReadonlyArray<string> = process.argv,
): "none" | "all" => {
  if (inCi(env)) {
    const asked = vitestUpdate(argv);
    if (asked !== undefined)
      throw new Error(`Vitest's update argument (${JSON.stringify(asked)}) refused: ${ciRefusal}`);
  }
  const asked = env[updateSnapshotsVariable];
  if (asked === undefined || asked === "") return "none";
  if (asked !== "1")
    throw new Error(
      `${updateSnapshotsVariable} is 1 to record snapshots, or unset; it was ${JSON.stringify(asked)}.`,
    );
  if (inCi(env)) throw new Error(ciRefusal);
  return "all";
};
