import { describe, expect, it } from "@effect/vitest";
import { normalizeExecutorServerConnection } from "@executor-js/sdk/shared";
import { resolveSupervisedDaemonAttach } from "./supervised-daemon";

const manifest = {
  version: 1 as const,
  kind: "cli-daemon" as const,
  pid: 1234,
  startedAt: "2026-06-18T00:00:00.000Z",
  dataDir: "C:\\Users\\rhys\\.executor",
  scopeDir: "C:\\Users\\rhys\\.executor",
  connection: normalizeExecutorServerConnection({
    origin: "http://localhost:4789",
    auth: { kind: "bearer" as const, token: "secret" },
  }),
  owner: {
    client: "cli" as const,
    version: "1.5.12",
    executablePath: "C:\\Users\\rhys\\.bun\\bin\\executor.exe",
  },
};

describe("resolveSupervisedDaemonAttach", () => {
  it("attaches to a reachable daemon without probing pid liveness first", async () => {
    let pidProbeCount = 0;

    const decision = await resolveSupervisedDaemonAttach(manifest, {
      isReachable: async () => true,
      isPidAlive: () => {
        pidProbeCount += 1;
        return false;
      },
    });

    expect(decision.kind).toBe("attach");
    expect(pidProbeCount).toBe(0);
  });

  it("removes the manifest only when the endpoint is unreachable and the pid is dead", async () => {
    const decision = await resolveSupervisedDaemonAttach(manifest, {
      isReachable: async () => false,
      isPidAlive: () => false,
    });

    expect(decision).toEqual({ kind: "remove-stale-manifest", pid: 1234 });
  });
});
