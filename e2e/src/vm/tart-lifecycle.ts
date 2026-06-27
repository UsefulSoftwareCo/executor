import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Schema } from "effect";

import { vmRunScopeSlug } from "./run-scope";
import {
  readTartOwnership,
  removeTartOwnership,
  requireTartCleanupOwner,
  selectCurrentTartOwnership,
  selectExpiredTartOwnership,
  type TartOwnershipLedger,
} from "./tart-ownership";
import { sleep } from "./types";

const execFileP = promisify(execFile);

const TartVmListEntry = Schema.Struct({
  Name: Schema.String,
  Running: Schema.Boolean,
  State: Schema.String,
});
const decodeTartVmList = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(TartVmListEntry)),
);
type TartVmListEntry = typeof TartVmListEntry.Type;

export type TartCommandRunner = (args: readonly string[]) => Promise<string>;

export interface TartRunProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export const tartScopePrefix = (scope: string) => `executor-e2e-${vmRunScopeSlug(scope)}-`;

export const tartResourceName = (scope: string, os: "linux" | "macos", unique: string) =>
  `${tartScopePrefix(scope)}${os}-${unique.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 32)}`;

const hasExited = (child: TartRunProcess) => child.exitCode !== null || child.signalCode !== null;

export const terminateTartRunProcess = async (
  child: TartRunProcess,
  options?: {
    readonly pollAttempts?: number;
    readonly pollIntervalMs?: number;
    readonly wait?: (ms: number) => Promise<void>;
  },
) => {
  if (hasExited(child)) return;
  const attempts = options?.pollAttempts ?? 100;
  const intervalMs = options?.pollIntervalMs ?? 100;
  const wait = options?.wait ?? sleep;

  const waitForExit = async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (hasExited(child)) return true;
      await wait(intervalMs);
    }
    return hasExited(child);
  };

  const signaled = child.kill("SIGINT");
  if (!signaled && !hasExited(child)) {
    throw new Error("tart run process rejected SIGINT");
  }
  if (await waitForExit()) return;

  const killed = child.kill("SIGKILL");
  if (!killed && !hasExited(child)) {
    throw new Error("tart run process rejected SIGKILL");
  }
  if (!(await waitForExit())) {
    throw new Error("tart run process did not exit after SIGKILL");
  }
};

const defaultTartRunner =
  (environment: Readonly<Record<string, string | undefined>>): TartCommandRunner =>
  async (args) => {
    const executable = environment.E2E_TART_BIN?.trim() || "/opt/homebrew/bin/tart";
    const { stdout } = await execFileP(executable, [...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  };

export const listTartVms = async (runner: TartCommandRunner) =>
  decodeTartVmList(await runner(["list", "--source", "local", "--format", "json"]));

export const deleteTartVmAndVerify = async (name: string, runner: TartCommandRunner) => {
  await runner(["delete", name]);
  const remaining = await listTartVms(runner);
  if (remaining.some((entry) => entry.Name === name)) {
    throw new Error(`tart VM still exists after deletion: ${name}`);
  }
};

const assertKnownTartState = (entry: TartVmListEntry) => {
  const consistent =
    (entry.State === "running" && entry.Running) ||
    ((entry.State === "stopped" || entry.State === "suspended") && !entry.Running);
  if (!consistent) {
    throw new Error(
      `refusing to clean tart VM with unknown or inconsistent state: ${entry.Name} (${entry.State})`,
    );
  }
};

const cleanupOwnedTartResources = async (
  ledgers: readonly TartOwnershipLedger[],
  runner: TartCommandRunner,
) => {
  if (ledgers.length === 0) return { deleted: 0, ledgersRemoved: 0 };
  const listed = await listTartVms(runner);
  const byName = new Map(listed.map((entry) => [entry.Name, entry]));
  const plans = ledgers.map((ledger) => ({ ledger, vm: byName.get(ledger.record.vmName) }));
  for (const plan of plans) {
    if (plan.vm) assertKnownTartState(plan.vm);
  }

  const failures: unknown[] = [];
  let deleted = 0;
  let ledgersRemoved = 0;
  for (const { ledger, vm } of plans) {
    if (!vm) {
      try {
        removeTartOwnership(ledger);
        ledgersRemoved += 1;
      } catch (error) {
        failures.push(
          new AggregateError(
            [error],
            `failed to remove stale tart ownership: ${ledger.record.vmName}`,
          ),
        );
      }
      continue;
    }

    if (vm.State !== "stopped") {
      try {
        await runner(["stop", "--timeout", "30", vm.Name]);
      } catch (error) {
        failures.push(new AggregateError([error], `failed to stop tart VM: ${vm.Name}`));
      }
    }

    let deletedVm = false;
    try {
      await deleteTartVmAndVerify(vm.Name, runner);
      deletedVm = true;
      deleted += 1;
    } catch (error) {
      failures.push(new AggregateError([error], `failed to delete tart VM: ${vm.Name}`));
    }
    if (deletedVm) {
      try {
        removeTartOwnership(ledger);
        ledgersRemoved += 1;
      } catch (error) {
        failures.push(
          new AggregateError([error], `failed to remove tart ownership: ${ledger.record.vmName}`),
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "tart cleanup was incomplete");
  }
  return { deleted, ledgersRemoved };
};

export const cleanupCurrentTartResources = async (options?: {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: TartCommandRunner;
}) => {
  const environment = options?.environment ?? process.env;
  const owner = requireTartCleanupOwner(environment);
  const runner = options?.runner ?? defaultTartRunner(environment);
  const ledgers = selectCurrentTartOwnership(readTartOwnership(environment), owner);
  return { ...(await cleanupOwnedTartResources(ledgers, runner)), scope: owner.scope };
};

export const sweepExpiredTartResources = async (options: {
  readonly minimumAgeHours: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
  readonly runner?: TartCommandRunner;
}) => {
  const environment = options.environment ?? process.env;
  const owner = requireTartCleanupOwner(environment);
  const runner = options.runner ?? defaultTartRunner(environment);
  const ledgers = selectExpiredTartOwnership(
    readTartOwnership(environment),
    owner,
    options.minimumAgeHours,
    options.now,
  );
  return {
    ...(await cleanupOwnedTartResources(ledgers, runner)),
    repository: owner.repository,
  };
};
