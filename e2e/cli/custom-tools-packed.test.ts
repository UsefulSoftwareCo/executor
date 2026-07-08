/* oxlint-disable executor/no-try-catch-or-throw -- boundary: e2e SSH and raw HTTP assertions */
// Proves the compiled executor binary's bundled workerd + worker-bundler path
// can package local-directory custom tools on every CLI guest OS. The sync
// assertion covers npm install inside workerd, including the Windows TLS trust
// path fixed by f0365449, and the execution assertion proves the published tool
// is invoked, not just synced.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";

const execFileAsync = promisify(execFile);

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "LogLevel=ERROR",
] as const;

type GuestOs = "macos" | "linux" | "windows";

interface SyncResponse {
  readonly status: "published" | "up-to-date" | "failed";
  readonly tools: readonly string[];
}

interface ExecuteResponse {
  readonly structured: unknown;
  readonly text: string;
}

const guestOs = (): GuestOs => {
  const os = process.env.E2E_VM_OS;
  if (os === "macos" || os === "linux" || os === "windows") return os;
  throw new Error(`Unsupported E2E_VM_OS: ${os ?? "<unset>"}`);
};

const sshInvocation = (command: string): { command: string; args: ReadonlyArray<string> } => {
  const host = process.env.E2E_CLI_VM_HOST;
  if (!host) throw new Error("E2E_CLI_VM_HOST is not set");
  const os = guestOs();
  const wrapped =
    os === "linux" ? `export XDG_RUNTIME_DIR=/run/user/$(id -u); ${command}` : command;
  const keyPath = process.env.E2E_CLI_SSH_KEY;
  const user = os === "windows" ? "Administrator" : "admin";
  return keyPath
    ? { command: "ssh", args: ["-i", keyPath, ...SSH_OPTS, `${user}@${host}`, wrapped] }
    : {
        command: process.env.E2E_SSHPASS_BIN ?? "/opt/homebrew/bin/sshpass",
        args: ["-p", "admin", "ssh", ...SSH_OPTS, `${user}@${host}`, wrapped],
      };
};

const ssh = async (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
  const invocation = sshInvocation(command);
  try {
    const { stdout, stderr } = await execFileAsync(invocation.command, [...invocation.args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
};

const fixturePath = (slug: string): string =>
  guestOs() === "windows"
    ? `C:/Users/Administrator/apps-packed-fixture-${slug}`
    : `/tmp/apps-packed-fixture-${slug}`;

const windowsFixtureCommand = (path: string): string => `
$ErrorActionPreference = 'Stop'
Remove-Item -Recurse -Force '${path}' -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path '${path}/tools' | Out-Null
Set-Content -NoNewline -Encoding UTF8 -Path '${path}/tools/greet.ts' -Value @'
${"import"} { z } from "zod";
${"import"} { defineTool } from "executor:app";

const Input = z.object({ name: z.string() });

export default defineTool({
  description: "Greet",
  input: Input,
  async handler(input) {
    return { greeting: "hello " + input.name };
  },
});
'@
Set-Content -NoNewline -Encoding UTF8 -Path '${path}/package.json' -Value '{"name":"packed-apps-smoke","dependencies":{"zod":"4.3.6"}}'
Set-Content -NoNewline -Encoding UTF8 -Path '${path}/bun.lock' -Value ''
`;

const unixFixtureCommand = (path: string): string => `
set -eu
rm -rf '${path}'
mkdir -p '${path}/tools'
cat >'${path}/tools/greet.ts' <<'EOF'
${"import"} { z } from "zod";
${"import"} { defineTool } from "executor:app";

const Input = z.object({ name: z.string() });

export default defineTool({
  description: "Greet",
  input: Input,
  async handler(input) {
    return { greeting: "hello " + input.name };
  },
});
EOF
printf '%s' '{"name":"packed-apps-smoke","dependencies":{"zod":"4.3.6"}}' >'${path}/package.json'
: >'${path}/bun.lock'
`;

const writeFixture = async (path: string): Promise<void> => {
  const result = await ssh(
    guestOs() === "windows" ? windowsFixtureCommand(path) : unixFixtureCommand(path),
  );
  expect(
    result.code,
    `fixture is written into the guest\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
};

const removeFixture = (path: string): Effect.Effect<void> =>
  Effect.promise(() =>
    ssh(
      guestOs() === "windows"
        ? `Remove-Item -Recurse -Force '${path}' -ErrorAction SilentlyContinue`
        : `rm -rf '${path}'`,
    ).then(() => undefined),
  ).pipe(Effect.ignore);

const request = async <T>(
  target: TargetShape,
  identity: Identity,
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
  timeoutMs = 30_000,
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(identity.headers ?? {})) headers.set(name, value);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(new URL(path, target.baseUrl), {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    expect(response.status, `${init.method ?? "GET"} ${path}: ${text}`).toBe(expectedStatus);
    return (text.length > 0 ? JSON.parse(text) : null) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const postJson = <T>(
  target: TargetShape,
  identity: Identity,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> =>
  request<T>(
    target,
    identity,
    path,
    {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    200,
    timeoutMs,
  );

const deleteSource = (target: TargetShape, identity: Identity, slug: string): Effect.Effect<void> =>
  Effect.promise(() =>
    request(target, identity, `/api/apps/sources/${slug}`, { method: "DELETE" }).then(
      () => undefined,
    ),
  ).pipe(Effect.ignore);

const syncAndInvoke = (input: {
  readonly target: TargetShape;
  readonly identity: Identity;
  readonly slug: string;
  readonly path: string;
}): Effect.Effect<void> =>
  Effect.promise(async () => {
    await postJson(input.target, input.identity, "/api/apps/sources", {
      kind: "local-directory",
      slug: input.slug,
      app: input.slug,
      path: input.path,
    });

    const sync = await postJson<SyncResponse>(
      input.target,
      input.identity,
      `/api/apps/sources/${input.slug}/sync`,
      undefined,
      180_000,
    );
    expect(sync.status, "the packed binary bundled and published the tool").toBe("published");
    expect(sync.tools, "the packed binary bundled and published the tool").toContain("greet");

    const execution = await postJson<ExecuteResponse>(
      input.target,
      input.identity,
      "/api/executions",
      {
        code: `export default await tools["${input.slug}.org.published.greet"]({ name: "Ada" })`,
        autoApprove: true,
      },
    );
    expect(
      JSON.stringify(execution.structured ?? execution.text),
      "the published tool executes and returns the greeting",
    ).toContain('"greeting":"hello Ada"');
  });

scenario(
  "CLI packed binary · local-directory custom tool publishes and executes",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const identity = yield* target.newIdentity();
    const slug = `packed-smoke-${crypto.randomUUID().slice(0, 8)}`;
    const path = fixturePath(slug);

    yield* Effect.promise(() => writeFixture(path)).pipe(
      Effect.andThen(syncAndInvoke({ target, identity, slug, path })),
      Effect.ensuring(
        Effect.all([deleteSource(target, identity, slug), removeFixture(path)], {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    );
  }),
);
