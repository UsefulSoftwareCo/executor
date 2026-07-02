/* oxlint-disable executor/no-try-catch-or-throw -- boundary: Electron startup must convert service-install failures into a fresh daemon probe */
import type { SidecarConnection } from "./sidecar";

export interface ReplaceSupervisedDaemonInput {
  readonly install: () => Promise<void>;
  readonly waitForAttach: () => Promise<SidecarConnection | null>;
  readonly attach: () => Promise<SidecarConnection | null>;
  readonly onInstallFailure?: (error: unknown, staleConnection: SidecarConnection) => void;
}

export const replaceSupervisedDaemonForDesktop = async (
  staleConnection: SidecarConnection,
  input: ReplaceSupervisedDaemonInput,
): Promise<SidecarConnection | null> => {
  try {
    await input.install();
    return (await input.waitForAttach()) ?? (await input.attach());
  } catch (error) {
    input.onInstallFailure?.(error, staleConnection);
    return await input.attach();
  }
};
