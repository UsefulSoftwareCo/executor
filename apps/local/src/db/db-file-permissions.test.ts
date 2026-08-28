// The local database sits in the same directory as `auth.json` and
// `server-connections.json`, both of which are deliberately 0600. SQLite
// creates its own files with the process umask instead, so on a default macOS
// or Linux install the database and its WAL sidecars land at 0644 — readable
// by every other account on the machine.
//
// These drive the real `openLocalLibsql` against a real file, because the
// property under test is what the filesystem ends up holding, not what the
// code appears to ask for.

import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { openLocalLibsql } from "./libsql";

const dirs: string[] = [];
const clients: Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** POSIX permission bits of `path`, or null when it does not exist. */
const modeOf = (path: string): number | null =>
  existsSync(path) ? statSync(path).mode & 0o777 : null;

const tempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `executor-db-perms-${label}-`));
  dirs.push(dir);
  return dir;
};

/** Every file in `dir` that any account other than the owner can read. */
const groupOrWorldReadable = (dir: string): readonly string[] =>
  readdirSync(dir).filter((name) => ((modeOf(join(dir, name)) ?? 0) & 0o044) !== 0);

describe("local database file permissions", () => {
  it("leaves nothing in the data directory readable by other accounts", async () => {
    const dir = tempDir("create");
    const path = join(dir, "data.db");

    const client = await openLocalLibsql(path);
    clients.push(client);
    // Force a write so WAL materializes its sidecars.
    await client.execute("CREATE TABLE probe (id INTEGER PRIMARY KEY)");

    expect(modeOf(path)).toBe(0o600);
    // Asserting over the whole directory rather than a fixed list of suffixes:
    // it does not depend on which sidecars SQLite happened to create, and it
    // names the offenders when it fails.
    expect(groupOrWorldReadable(dir)).toEqual([]);
  });

  it("tightens a database left world-readable by an earlier version", async () => {
    // The upgrade path is the one that matters: a `mode` at creation cannot
    // help a file that already exists, which is why the fix chmods on open.
    const dir = tempDir("upgrade");
    const path = join(dir, "data.db");

    const seed = createClient({ url: `file:${path}` });
    await seed.execute("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    seed.close();
    // Put the file into the exact state a pre-fix install leaves behind.
    chmodSync(path, 0o644);
    expect(modeOf(path)).toBe(0o644);

    const client = await openLocalLibsql(path);
    clients.push(client);

    expect(modeOf(path)).toBe(0o600);
    expect(groupOrWorldReadable(dir)).toEqual([]);
  });

  it("POSITIVE CONTROL: a raw libSQL open leaves the database world-readable", async () => {
    // Proves the assertions above can fail. Without this, a chmod that
    // silently stopped running would still leave them green on a machine with
    // a strict umask — this is the check that the check works.
    const dir = tempDir("control");
    const path = join(dir, "data.db");

    const client = createClient({ url: `file:${path}` });
    await client.execute("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    client.close();

    expect(modeOf(path)).not.toBe(0o600);
    expect(groupOrWorldReadable(dir)).toContain("data.db");
  });

  it("does not throw for an in-memory database", async () => {
    const client = await openLocalLibsql(":memory:");
    clients.push(client);
    await expect(client.execute("SELECT 1")).resolves.toBeDefined();
  });
});
