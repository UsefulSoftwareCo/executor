import type { ExecutorLocalServerManifest } from "@executor-js/sdk/shared";

type CliDaemonManifest = ExecutorLocalServerManifest & { readonly kind: "cli-daemon" };

type SupervisedDaemonAttachDecision =
  | {
      readonly _tag: "Attach";
      readonly manifest: CliDaemonManifest;
      readonly authToken: string;
    }
  | { readonly _tag: "RemoveStaleManifest"; readonly pid: number }
  | { readonly _tag: "Unavailable" };

export const resolveSupervisedDaemonAttach = async (
  manifest: ExecutorLocalServerManifest | null,
  input: {
    readonly isReachable: (origin: string) => Promise<boolean>;
    readonly isPidAlive: (pid: number) => boolean;
  },
): Promise<SupervisedDaemonAttachDecision> => {
  if (!manifest || manifest.kind !== "cli-daemon") return { _tag: "Unavailable" };
  const cliManifest = { ...manifest, kind: "cli-daemon" as const };

  if (await input.isReachable(cliManifest.connection.origin)) {
    const auth = cliManifest.connection.auth;
    const authToken = auth && auth.kind === "bearer" ? auth.token : "";
    return { _tag: "Attach", manifest: cliManifest, authToken };
  }

  if (!input.isPidAlive(cliManifest.pid)) {
    return { _tag: "RemoveStaleManifest", pid: cliManifest.pid };
  }

  return { _tag: "Unavailable" };
};
