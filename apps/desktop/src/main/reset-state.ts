/**
 * Last-resort recovery for a data dir the sidecar can no longer open
 * (failed migration, corrupted SQLite, …): move the executor state aside
 * and start fresh.
 *
 * Strictly backup-then-move — nothing is ever deleted. data.db holds the
 * user's connections and secrets, so the old state lands in a timestamped
 * folder under ~/.executor/backups/ where it can be restored by copying
 * the files back.
 *
 * Scope: only the sidecar-owned state (data.db + SQLite sidecar files and
 * server-control/). The plugin manifest (executor.jsonc) is user-authored
 * config, not state — a reset shouldn't discard hand-written setup — and
 * desktop settings (port/auth) live in Electron's own store, unaffected.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dialog, shell } from "electron";
import log from "electron-log/main.js";

const STATE_ENTRIES = ["data.db", "data.db-wal", "data.db-shm", "server-control"];

const backupStamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export interface ResetStateResult {
  readonly backupDir: string;
  readonly moved: ReadonlyArray<string>;
}

/**
 * Move the executor state into ~/.executor/backups/<stamp>/. The caller is
 * responsible for stopping the sidecar first and restarting it after.
 */
export const resetExecutorState = (): ResetStateResult => {
  const dataDir = join(homedir(), ".executor");
  const backupDir = join(dataDir, "backups", backupStamp());
  mkdirSync(backupDir, { recursive: true });
  const moved: string[] = [];
  for (const entry of STATE_ENTRIES) {
    const from = join(dataDir, entry);
    if (!existsSync(from)) continue;
    renameSync(from, join(backupDir, entry));
    moved.push(entry);
  }
  log.info("[reset-state] moved executor state to backup", { backupDir, moved });
  return { backupDir, moved };
};

/**
 * Confirmation dialog shared by every surface that offers a reset. Returns
 * true when the user explicitly chose to reset.
 *
 * EXECUTOR_TEST_AUTO_CONFIRM_RESET=1 skips the dialog — native dialogs are
 * unreachable from Playwright, and the e2e crash-recovery scenario needs to
 * drive the full reset path.
 */
export const confirmResetState = async (): Promise<boolean> => {
  if (process.env.EXECUTOR_TEST_AUTO_CONFIRM_RESET === "1") return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Reset Executor data?",
    message: "Start over with a fresh data directory?",
    detail:
      "Your current data — integrations, connections, and history — will be moved to " +
      "~/.executor/backups (not deleted), and Executor will restart with a clean slate. " +
      "Use this when the app can't start because its data is damaged.",
    buttons: ["Reset and back up", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
};

/**
 * Make the "your data is backed up" promise concrete after a reset: name the
 * exact folder and offer to open it. Without this the user is told their data
 * is safe somewhere but has no way to act on it.
 */
export const announceBackup = async (backupDir: string): Promise<void> => {
  // Same test seam as confirmResetState: a modal with no one to dismiss it
  // would hang the e2e reset path.
  if (process.env.EXECUTOR_TEST_AUTO_CONFIRM_RESET === "1") {
    log.info("[reset-state] backup announced (test mode, dialog skipped)", { backupDir });
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Executor data reset",
    message: "Your previous data has been backed up.",
    detail:
      `If you need anything from before the reset, it's all here:\n\n${backupDir}\n\n` +
      "You can ignore this folder otherwise — Executor is now running on a fresh data directory.",
    buttons: ["Show in folder", "OK"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) shell.showItemInFolder(backupDir);
};
