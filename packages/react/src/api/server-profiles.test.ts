import { describe, expect, it } from "@effect/vitest";

import {
  getActiveExecutorServerProfile,
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
});
