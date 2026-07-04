import { describe, expect, it } from "@effect/vitest";

import {
  McpExecutionOwnerDirectoryDO,
  type McpExecutionOwnerRecord,
} from "./execution-owner-directory";

class FakeStorage {
  private readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

const makeDirectory = () => {
  const storage = new FakeStorage();
  const directory = new McpExecutionOwnerDirectoryDO({
    storage,
  });
  return { directory, storage };
};

const record = (input?: Partial<McpExecutionOwnerRecord>): McpExecutionOwnerRecord => ({
  executionId: "exec_1",
  owner: { sessionId: "session_a" },
  accountId: "acct_1",
  organizationId: "org_1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ttlMs: 60_000,
  ...input,
});

describe("McpExecutionOwnerDirectoryDO", () => {
  it("stores and reads an unexpired execution owner record", async () => {
    const { directory, storage } = makeDirectory();
    const entry = record();

    await directory.put(entry);

    expect(await directory.get("exec_1")).toEqual(entry);
    expect(storage.alarmAt).toBe(Date.parse(entry.expiresAt));
  });

  it("treats expired records as absent and deletes them", async () => {
    const { directory, storage } = makeDirectory();
    const entry = record({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await directory.put(entry);

    expect(await directory.get("exec_1")).toBeNull();
    expect(await storage.get("owner")).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });

  it("alarm deletes the owner record", async () => {
    const { directory, storage } = makeDirectory();
    await directory.put(record());

    await directory.alarm();

    expect(await storage.get("owner")).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });
});
