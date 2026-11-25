import { parseCLI } from "vitest/node";

export const updateSnapshotsVariable = "E2E_UPDATE_SNAPSHOTS";

export const inCi = (env: Readonly<Record<string, string | undefined>>) =>
  Boolean(env.CI) || Boolean(env.GITHUB_ACTIONS);

export const ciRefusal =
  "Snapshots are recorded only on purpose, on a workstation: CI runs never write them. Record them locally with --update-snapshots and --test-name, read every changed line in git diff, then commit.";

export const unnamedRefusal =
  "--update-snapshots records only the scenarios --test-name names, so their changes can be read line by line.";

export const namesNoScenario = (name: string) => name.trim() === "";

const vitestUpdate = (argv: ReadonlyArray<string>) => {
  const asked: unknown = parseCLI(["vitest", ...argv.slice(2)]).options.update;
  return asked === undefined || asked === false || asked === "none" ? undefined : asked;
};

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
