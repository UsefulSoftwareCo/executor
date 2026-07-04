import type { DesktopUpdateStatus } from "../shared/update";

export type UpdateCheckTrigger = "boot" | "interval" | "manual";

export interface UpdateCheckPlan {
  readonly check: boolean;
  readonly promptVersionAfterCheck: string | null;
}

export interface CompletedUpdateCheckInput {
  readonly stagedVersion: string | null;
  readonly trigger: UpdateCheckTrigger;
  readonly updateAvailable: boolean;
  readonly availableVersion: string | null;
}

export interface DownloadedUpdateInput {
  readonly stagedVersion: string | null;
  readonly declinedVersion: string | null;
  readonly incomingVersion: string;
  readonly trigger: UpdateCheckTrigger;
}

export interface DownloadedUpdatePlan {
  readonly stagedVersion: string;
  readonly declinedVersion: string | null;
  readonly status: DesktopUpdateStatus;
  readonly promptVersion: string | null;
}

const parseVersionParts = (version: string): readonly number[] | null => {
  const core = version.trim().split(/[+-]/, 1)[0];
  if (!core) return null;
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isInteger(part) && part >= 0) ? parts : null;
};

export const compareUpdateVersions = (left: string, right: string): number | null => {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return null;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const l = leftParts[index] ?? 0;
    const r = rightParts[index] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
};

const isNewerUpdateVersion = (incomingVersion: string, declinedVersion: string): boolean => {
  const comparison = compareUpdateVersions(incomingVersion, declinedVersion);
  return comparison === null ? incomingVersion !== declinedVersion : comparison > 0;
};

export const planUpdateCheck = (input: {
  readonly stagedVersion: string | null;
  readonly trigger: UpdateCheckTrigger;
}): UpdateCheckPlan => ({
  check: true,
  promptVersionAfterCheck: input.trigger === "manual" ? input.stagedVersion : null,
});

export const planCompletedUpdateCheck = (
  input: CompletedUpdateCheckInput,
): { readonly promptVersion: string | null } => {
  if (input.trigger !== "manual" || !input.stagedVersion) return { promptVersion: null };
  if (!input.updateAvailable) return { promptVersion: input.stagedVersion };
  if (!input.availableVersion) return { promptVersion: null };
  const comparison = compareUpdateVersions(input.availableVersion, input.stagedVersion);
  if (comparison === null) {
    return {
      promptVersion: input.availableVersion === input.stagedVersion ? input.stagedVersion : null,
    };
  }
  return { promptVersion: comparison <= 0 ? input.stagedVersion : null };
};

export const planDownloadedUpdate = (input: DownloadedUpdateInput): DownloadedUpdatePlan => {
  const prompt =
    input.trigger === "manual" ||
    !input.declinedVersion ||
    isNewerUpdateVersion(input.incomingVersion, input.declinedVersion);
  return {
    stagedVersion: input.incomingVersion,
    declinedVersion: input.declinedVersion,
    status: { state: "downloaded", version: input.incomingVersion },
    promptVersion: prompt ? input.incomingVersion : null,
  };
};

export const statusAfterUpdateError = (
  status: DesktopUpdateStatus,
  message: string,
): DesktopUpdateStatus => {
  if (status.state === "available" || status.state === "downloading" || status.state === "error") {
    return { state: "error", version: status.version, message };
  }
  return status;
};

export const handleUpdateDownloadRejection = (
  downloadPromise: Promise<unknown> | null | undefined,
  onRejected: (error: unknown) => void,
): boolean => {
  if (!downloadPromise) return false;
  // oxlint-disable-next-line executor/no-promise-catch -- boundary: electron-updater hands back a floating native promise; attaching a rejection handler is the whole point
  void downloadPromise.catch(onRejected);
  return true;
};

export const planFatalAutoInstallOnQuit = (input: {
  readonly packaged: boolean;
  readonly retryAfterReset: boolean;
}): { readonly enableDuringFailure: boolean; readonly restoreAfterRecovery: boolean } => ({
  enableDuringFailure: input.packaged,
  restoreAfterRecovery: input.packaged && input.retryAfterReset,
});
