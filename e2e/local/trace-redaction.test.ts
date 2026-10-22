import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "@effect/vitest";

import { redactTraceArchive, TraceRedactionError } from "../src/trace-redaction";
import { collectIdentitySecrets } from "../src/surfaces/browser";

const execFileAsync = promisify(execFile);

const makeArchive = async (directory: string, archive: string, secret: string): Promise<void> => {
  const encoded = Buffer.from(secret).toString("base64");
  const encodedUrl = Buffer.from(secret).toString("base64url");
  writeFileSync(
    join(directory, "trace.txt"),
    [secret, encodeURIComponent(secret), encoded, encodedUrl].join("\n"),
  );
  writeFileSync(join(directory, "screenshot.bin"), Buffer.from([0xff, 0x00, 0x01, 0xfe]));
  await execFileAsync("zip", ["-q", archive, "trace.txt", "screenshot.bin"], {
    cwd: directory,
  });
};

const readEntry = async (archive: string, name: string): Promise<Buffer> => {
  const result = await execFileAsync("unzip", ["-p", archive, name], { encoding: null });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
};

it("redacts text entries while preserving binary trace assets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "executor-redaction-test-"));
  const archive = join(directory, "trace.zip");
  const secret = "e2e-redaction-secret-value";
  try {
    await makeArchive(directory, archive, secret);
    const beforeBinary = readFileSync(join(directory, "screenshot.bin"));

    await redactTraceArchive(archive, [secret]);

    const text = await readEntry(archive, "trace.txt");
    const afterBinary = await readEntry(archive, "screenshot.bin");
    for (const value of [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
    ]) {
      expect(text.includes(value)).toBe(false);
    }
    expect(afterBinary.equals(beforeBinary)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("removes an archive when redaction cannot read it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "executor-redaction-test-"));
  const archive = join(directory, "invalid.zip");
  try {
    writeFileSync(archive, "not a zip archive");

    await expect(
      redactTraceArchive(archive, ["e2e-redaction-secret-value"]),
    ).rejects.toBeInstanceOf(TraceRedactionError);
    expect(existsSync(archive)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("collects every browser identity credential for trace redaction", () => {
  const identity = {
    label: "member",
    headers: {
      authorization: "Bearer identity-value",
      cookie: "session=session-cookie; csrf=csrf-value",
      origin: "http://localhost",
    },
    cookies: [{ name: "session", value: "session-cookie" }],
    credentials: { email: "member@example.test", password: "password-value" },
  };
  const registered = collectIdentitySecrets(identity);
  expect(registered.includes(identity.headers.authorization)).toBe(true);
  expect(registered.includes("identity-value")).toBe(true);
  expect(registered.includes(identity.headers.cookie)).toBe(true);
  expect(registered.includes("session-cookie")).toBe(true);
  expect(registered.includes("csrf-value")).toBe(true);
  expect(registered.includes(identity.headers.origin)).toBe(false);
  expect(registered.includes(identity.cookies[0]!.value)).toBe(true);
  expect(registered.includes(identity.credentials.password)).toBe(true);
});
