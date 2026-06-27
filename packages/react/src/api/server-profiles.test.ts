import { describe, expect, it } from "@effect/vitest";

import {
  createExecutorServerProfileKey,
  getActiveExecutorServerProfile,
  mergeExecutorDesktopSidecarProfile,
  parseExecutorServerProfilesSnapshot,
  readExecutorServerProfiles,
  removeExecutorServerProfile,
  selectExecutorServerProfile,
  serializeExecutorServerProfilesSnapshot,
  upsertExecutorServerProfile,
  writeExecutorServerProfiles,
  type ExecutorServerProfileStorage,
} from "./server-profiles";

const makeStorage = (): ExecutorServerProfileStorage & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

describe("Executor server profiles", () => {
  it("reads and normalizes persisted server profiles", () => {
    const storage = makeStorage();
    storage.setItem(
      "profiles",
      JSON.stringify({
        version: 1,
        activeKey: "http:http://localhost:4788",
        profiles: [
          { origin: "localhost:4788", displayName: "Local" },
          { origin: "not a url" },
          { origin: "https://executor.example", displayName: "Hosted" },
        ],
      }),
    );

    const snapshot = readExecutorServerProfiles(storage, "profiles");

    expect(snapshot.activeKey).toBe("http:http://localhost:4788");
    expect(snapshot.profiles.map((profile) => profile.origin)).toEqual([
      "http://localhost:4788",
      "https://executor.example",
    ]);
  });

  it("drops malformed profile storage", () => {
    const storage = makeStorage();
    storage.setItem("profiles", "{");

    expect(readExecutorServerProfiles(storage, "profiles")).toEqual({
      activeKey: null,
      profiles: [],
    });
  });

  it("upserts, selects, removes, and persists profiles", () => {
    const storage = makeStorage();
    const first = upsertExecutorServerProfile(
      { activeKey: null, profiles: [] },
      { origin: "http://127.0.0.1:4788", displayName: "Local" },
    );
    expect(first?.activeKey).toBe("http:http://127.0.0.1:4788");

    const second = upsertExecutorServerProfile(first!, {
      origin: "https://executor.example",
      displayName: "Hosted",
      auth: { kind: "bearer", token: "token_123" },
    });
    expect(getActiveExecutorServerProfile(second!)?.displayName).toBe("Hosted");

    const selected = selectExecutorServerProfile(second!, "http:http://127.0.0.1:4788");
    expect(getActiveExecutorServerProfile(selected)?.displayName).toBe("Local");

    writeExecutorServerProfiles(storage, selected, "profiles");
    expect(storage.values.get("profiles")).toContain("token_123");

    const roundTripped = readExecutorServerProfiles(storage, "profiles");
    expect(roundTripped.profiles).toHaveLength(2);
    expect(roundTripped.profiles[1]?.auth).toEqual({ kind: "bearer", token: "token_123" });

    const serialized = serializeExecutorServerProfilesSnapshot(roundTripped);
    expect(parseExecutorServerProfilesSnapshot(serialized).profiles[1]?.auth).toEqual({
      kind: "bearer",
      token: "token_123",
    });

    const removed = removeExecutorServerProfile(roundTripped, "http:http://127.0.0.1:4788");
    expect(removed.activeKey).toBe("http:https://executor.example");
  });

  it("keeps same-origin accounts isolated across profile switches", () => {
    const firstKey = createExecutorServerProfileKey();
    const secondKey = createExecutorServerProfileKey();
    expect(firstKey).not.toBe(secondKey);

    const local = upsertExecutorServerProfile(
      { activeKey: null, profiles: [] },
      {
        kind: "desktop-sidecar",
        key: "desktop-sidecar",
        origin: "http://127.0.0.1:4788",
        displayName: "Desktop",
        auth: { kind: "bearer", token: "token_desktop" },
      },
    );
    const first = upsertExecutorServerProfile(local!, {
      key: firstKey,
      origin: "https://executor.example",
      displayName: "Account A",
      auth: { kind: "bearer", token: "token_account_a" },
    });
    const second = upsertExecutorServerProfile(first!, {
      key: secondKey,
      origin: "https://executor.example",
      displayName: "Account B",
      auth: { kind: "bearer", token: "token_account_b" },
    });

    expect(second?.profiles).toHaveLength(3);
    expect(second?.profiles.map((profile) => profile.key)).toEqual([
      "desktop-sidecar",
      firstKey,
      secondKey,
    ]);

    const selectedFirst = selectExecutorServerProfile(second!, firstKey);
    expect(getActiveExecutorServerProfile(selectedFirst)?.auth).toEqual({
      kind: "bearer",
      token: "token_account_a",
    });

    const selectedSecond = selectExecutorServerProfile(selectedFirst, secondKey);
    expect(getActiveExecutorServerProfile(selectedSecond)?.auth).toEqual({
      kind: "bearer",
      token: "token_account_b",
    });

    const selectedLocal = selectExecutorServerProfile(selectedSecond, "desktop-sidecar");
    expect(getActiveExecutorServerProfile(selectedLocal)?.kind).toBe("desktop-sidecar");

    const selectedFirstAgain = selectExecutorServerProfile(selectedLocal, firstKey);
    expect(getActiveExecutorServerProfile(selectedFirstAgain)?.auth).toEqual({
      kind: "bearer",
      token: "token_account_a",
    });

    const roundTripped = parseExecutorServerProfilesSnapshot(
      serializeExecutorServerProfilesSnapshot(selectedFirstAgain),
    );
    expect(roundTripped.profiles.map((profile) => profile.key)).toEqual([
      "desktop-sidecar",
      firstKey,
      secondKey,
    ]);
    expect(roundTripped.activeKey).toBe(firstKey);
  });

  it("merges a refreshed desktop sidecar without replacing the active remote profile", () => {
    const remoteKey = createExecutorServerProfileKey();
    const local = mergeExecutorDesktopSidecarProfile(
      { activeKey: null, profiles: [] },
      {
        kind: "desktop-sidecar",
        key: "desktop-sidecar",
        origin: "http://127.0.0.1:4788",
        displayName: "Old sidecar",
      },
    );
    expect(local.activeKey).toBe("desktop-sidecar");
    const stored = upsertExecutorServerProfile(local, {
      key: remoteKey,
      origin: "https://executor.example",
      displayName: "Persisted remote",
      auth: { kind: "bearer", token: "token_remote" },
    })!;

    const merged = mergeExecutorDesktopSidecarProfile(stored, {
      kind: "desktop-sidecar",
      key: "desktop-sidecar",
      origin: "http://127.0.0.1:4799",
      displayName: "Current sidecar",
    });

    expect(merged.activeKey).toBe(remoteKey);
    expect(getActiveExecutorServerProfile(merged)?.displayName).toBe("Persisted remote");
    expect(merged.profiles.find((profile) => profile.kind === "desktop-sidecar")?.origin).toBe(
      "http://127.0.0.1:4799",
    );

    const restored = parseExecutorServerProfilesSnapshot(
      serializeExecutorServerProfilesSnapshot(merged),
    );
    expect(restored.activeKey).toBe(remoteKey);
    expect(getActiveExecutorServerProfile(restored)?.displayName).toBe("Persisted remote");
  });
});
