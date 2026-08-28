// ---------------------------------------------------------------------------
// The desktop settings store must be owner-only.
//
// `serverProfiles` carries a remote server's credential — a bearer token, or a
// basic-auth password — and `conf` (under electron-store) defaults to
// `configFileMode: 0o666`, so without an explicit mode the file lands 0644 under
// a normal umask. On Linux, where `~/.config` is not reliably 0700, that is
// readable by every other account on the machine.
//
// WHAT THIS TEST DOES AND DOES NOT BIND, stated plainly rather than left to be
// discovered. It exercises the real `electron-store` with the SAME options
// `settings.ts` passes, so it verifies the load-bearing uncertainty in that fix:
// that ONE option is enough, where the rest of this app uses a mode-plus-chmod
// pair. That shortcut rests on a claim about a transitive dependency —
// `atomically` chmods the temp inode only when the requested mode differs from
// its own default, and the atomic rename then carries the tight mode onto an
// already-loose file — and a claim about a dependency is worth checking rather
// than repeating.
//
// It does NOT bind the wiring in `settings.ts`. That module builds its store at
// module scope and pulls in `electron`, which cannot be imported outside an
// Electron runtime (`electron/index.js` throws from `getElectronPath`). That is
// why the repo has no `settings.test.ts` at all. Mocking `electron-store` away
// would leave the test asserting the mock rather than the behaviour that is
// actually in question, so the option itself is verified here and the wiring is
// left uncovered on purpose.
// ---------------------------------------------------------------------------

import { describe, expect, it, onTestFinished } from "@effect/vitest";
import Store from "electron-store";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The exact options `settings.ts` constructs its store with. */
const makeStore = (dir: string) =>
  new Store<{ readonly serverProfiles?: string }>({
    name: "settings",
    cwd: dir,
    configFileMode: 0o600,
    defaults: {},
  });

const settingsPathIn = (dir: string) => join(dir, "settings.json");

/** A temp dir removed when the test ends. `try/finally` would do the same, but the repo's
 *  no-try-catch-or-throw rule rejects the construct and a registered hook reads better. */
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe("electron-store configFileMode", () => {
  it("creates the settings file owner-only", () => {
    const dir = tempDir("executor-desktop-settings-");

    makeStore(dir).set("serverProfiles", JSON.stringify({ token: "sk-secret" }));

    expect(statSync(settingsPathIn(dir)).mode & 0o777).toBe(0o600);
  });

  it("tightens a settings file that already exists world-readable", () => {
    // This is the half that would silently not happen if the single option did
    // not trigger `atomically`'s chmod: an existing 0644 file from a build
    // without the mode set must not stay 0644 after the next write.
    const dir = tempDir("executor-desktop-settings-loose-");

    writeFileSync(settingsPathIn(dir), JSON.stringify({ serverProfiles: "old" }));
    chmodSync(settingsPathIn(dir), 0o644);

    makeStore(dir).set("serverProfiles", JSON.stringify({ token: "sk-secret" }));

    expect(statSync(settingsPathIn(dir)).mode & 0o777).toBe(0o600);
  });

  it("without the option, the file really is world-readable — the defect this pins", () => {
    // A control. Without it, both assertions above would pass just as happily on
    // a machine with a restrictive umask, and would prove nothing about the fix.
    const dir = tempDir("executor-desktop-settings-default-");

    new Store<{ readonly serverProfiles?: string }>({
      name: "settings",
      cwd: dir,
      defaults: {},
    }).set("serverProfiles", JSON.stringify({ token: "sk-secret" }));

    const mode = statSync(settingsPathIn(dir)).mode & 0o777;
    expect(mode).not.toBe(0o600);
    expect(mode & 0o044).not.toBe(0);
  });
});
