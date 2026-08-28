// What environment does a stdio MCP server actually receive?
//
// This spawns a real subprocess through the real transport and reads back the
// environment that process was handed. Asserting on the arguments we pass to
// the SDK would not answer the question — the SDK merges its own safe-list
// underneath ours, so the only honest answer comes from the child itself.
//
// The child is a plain node script rather than an MCP server: it is spawned by
// the same code path either way, and speaking the protocol would add nothing
// to what is being measured. It never completes a handshake, so the transport
// is closed once the file has been written.
//
// The child reports only the keys a test names. Dumping the whole environment
// would write the runner's own secrets to a temp file to answer a question
// about a handful of variables.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { createStdioTransport } from "./stdio-connector";

/** A variable only this test sets, standing in for a real one like
 *  `EXECUTOR_SECRET_KEY`. Using a fake keeps the test honest on a machine
 *  where the real one happens not to be set. */
const HOST_ONLY_SECRET = "EXECUTOR_TEST_HOST_ONLY_SECRET";
const HOST_ONLY_VALUE = "host-secret-that-must-not-reach-a-child";

const dirs: string[] = [];
/** Host variables a test set, restored rather than deleted: the machine
 *  running this may legitimately be behind a proxy. */
const restore = new Map<string, string | undefined>();

const setHostEnv = (key: string, value: string): void => {
  if (!restore.has(key)) restore.set(key, process.env[key]);
  process.env[key] = value;
};

afterEach(() => {
  for (const [key, value] of restore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restore.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Spawn a child through the transport and return which of `probe` it saw.
 * Keys the child did not receive are absent from the result.
 */
const envSeenByChild = async (
  declared: Record<string, string> | undefined,
  probe: ReadonlyArray<string>,
): Promise<Record<string, string>> => {
  const dir = mkdtempSync(join(tmpdir(), "executor-stdio-env-"));
  dirs.push(dir);
  const out = join(dir, "env.json");

  const transport = createStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      "const [out, ...keys] = process.argv.slice(1);" +
        "require('node:fs').writeFileSync(out, JSON.stringify(Object.fromEntries(" +
        "keys.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]]))" +
        ")))",
      out,
      ...probe,
    ],
    env: declared,
  });

  await transport.start();
  // The child writes and exits; poll briefly rather than assuming timing.
  for (let i = 0; i < 100 && !existsSync(out); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await transport.close();

  // oxlint-disable-next-line executor/no-json-parse -- boundary: reading back the raw env dump this test's own child process just wrote; the value is only key-checked, never decoded into domain types
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
};

describe("environment handed to a stdio MCP subprocess", () => {
  it("does not leak a host secret to a server that declares its own env", async () => {
    // The declared-env branch is the one that matters: it is the branch a
    // credential-bearing integration takes, and it was the leaking one.
    setHostEnv(HOST_ONLY_SECRET, HOST_ONLY_VALUE);

    const childEnv = await envSeenByChild({ DECLARED_TOKEN: "declared-value" }, [
      HOST_ONLY_SECRET,
      "DECLARED_TOKEN",
    ]);

    expect(childEnv[HOST_ONLY_SECRET]).toBeUndefined();
    // ...and the thing the integration actually asked for still arrives.
    expect(childEnv.DECLARED_TOKEN).toBe("declared-value");
  });

  it("does not leak a host secret to a server that declares no env", async () => {
    setHostEnv(HOST_ONLY_SECRET, HOST_ONLY_VALUE);

    const childEnv = await envSeenByChild(undefined, [HOST_ONLY_SECRET]);

    expect(childEnv[HOST_ONLY_SECRET]).toBeUndefined();
  });

  it("still provides the SDK's safe-list, so servers keep working", async () => {
    // The fix must not strand servers that legitimately need PATH to find
    // their own interpreter. The SDK's list is what supplies it.
    const childEnv = await envSeenByChild({ DECLARED_TOKEN: "declared-value" }, ["PATH", "HOME"]);

    expect(childEnv.PATH).toBeDefined();
    expect(childEnv.HOME).toBeDefined();
  });

  it("passes the host's proxy and CA configuration through, but nothing beside it", async () => {
    // A server behind a corporate proxy or an intercepting CA cannot reach
    // anything without these, and no source config declares them. Inheriting
    // this short list is the whole difference between the fix landing and the
    // fix breaking every install on such a network.
    setHostEnv("HTTPS_PROXY", "http://proxy.invalid:3128");
    setHostEnv("no_proxy", "localhost,127.0.0.1");
    setHostEnv("NODE_EXTRA_CA_CERTS", "/etc/ssl/certs/corporate.pem");
    setHostEnv(HOST_ONLY_SECRET, HOST_ONLY_VALUE);

    const childEnv = await envSeenByChild(undefined, [
      "HTTPS_PROXY",
      "no_proxy",
      "NODE_EXTRA_CA_CERTS",
      HOST_ONLY_SECRET,
    ]);

    expect(childEnv.HTTPS_PROXY).toBe("http://proxy.invalid:3128");
    expect(childEnv.no_proxy).toBe("localhost,127.0.0.1");
    expect(childEnv.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/corporate.pem");
    // The allowlist is an allowlist: a secret sitting beside those in the same
    // environment still does not travel.
    expect(childEnv[HOST_ONLY_SECRET]).toBeUndefined();
  });

  it("lets the source config override an inherited proxy value", async () => {
    // The allowlist is merged underneath the declared env, so a source that
    // needs its own egress route is not overruled by the host's.
    setHostEnv("HTTPS_PROXY", "http://host-proxy.invalid:3128");

    const childEnv = await envSeenByChild({ HTTPS_PROXY: "http://declared-proxy.invalid:8080" }, [
      "HTTPS_PROXY",
    ]);

    expect(childEnv.HTTPS_PROXY).toBe("http://declared-proxy.invalid:8080");
  });

  it("POSITIVE CONTROL: the child does report a variable when it is passed one", async () => {
    // Proves the measurement works. Without this, a child that failed to
    // write, or wrote an empty object, would satisfy every assertion above.
    setHostEnv(HOST_ONLY_SECRET, HOST_ONLY_VALUE);

    const childEnv = await envSeenByChild({ [HOST_ONLY_SECRET]: HOST_ONLY_VALUE }, [
      HOST_ONLY_SECRET,
    ]);

    expect(childEnv[HOST_ONLY_SECRET]).toBe(HOST_ONLY_VALUE);
  });
});
