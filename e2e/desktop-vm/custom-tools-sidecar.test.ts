/* oxlint-disable executor/no-try-catch-or-throw -- boundary: e2e SSH and raw HTTP assertions */
// Proves the packaged desktop bundle's sidecar daemon can package and invoke a
// local-directory custom tool from inside the GUI guest. The API calls run over
// guest loopback so the daemon reads the same guest filesystem as the fixture.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";

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

type DesktopOs = "macos" | "linux" | "windows";

interface CurlResult<T> {
  readonly status: number;
  readonly body: T;
  readonly text: string;
}

interface SyncResponse {
  readonly status: "published" | "up-to-date" | "failed";
  readonly tools: readonly string[];
}

interface ExecuteResponse {
  readonly structured: unknown;
  readonly text: string;
}

const NAME = "Desktop sidecar · local-directory custom tool publishes and executes";
const guestIp = process.env.E2E_DESKTOP_VM_IP;
const os: DesktopOs =
  process.env.E2E_TARGET === "desktop-windows"
    ? "windows"
    : process.env.E2E_TARGET === "desktop-linux"
      ? "linux"
      : "macos";

const token = (): string => (os === "linux" ? "desktop-linux-e2e" : "desktop-macos-e2e");

const ssh = async (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
  if (!guestIp) throw new Error("E2E_DESKTOP_VM_IP is not set");
  const wrapped =
    os === "linux" ? `export XDG_RUNTIME_DIR=/run/user/$(id -u); ${command}` : command;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.env.E2E_SSHPASS_BIN ?? "/opt/homebrew/bin/sshpass",
      ["-p", "admin", "ssh", ...SSH_OPTS, `admin@${guestIp}`, wrapped],
      { maxBuffer: 64 * 1024 * 1024 },
    );
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
  os === "linux"
    ? `/home/admin/apps-sidecar-fixture-${slug}`
    : `/Users/admin/apps-sidecar-fixture-${slug}`;

const writeFixtureCommand = (path: string): string => `
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
  const result = await ssh(writeFixtureCommand(path));
  expect(
    result.code,
    `fixture is written into the desktop guest\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
};

const removeFixture = (path: string): Effect.Effect<void> =>
  Effect.promise(() => ssh(`rm -rf '${path}'`).then(() => undefined)).pipe(Effect.ignore);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const guestRequest = async <T>(
  path: string,
  init: { readonly method: "POST" | "DELETE"; readonly body?: unknown },
  timeoutSeconds = 30,
): Promise<CurlResult<T>> => {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const bodyFlag = body === undefined ? "" : ` --data-binary ${shellQuote(body)}`;
  const command = [
    "curl",
    "-sS",
    "--max-time",
    String(timeoutSeconds),
    "-w",
    shellQuote("\\n__HTTP_STATUS__:%{http_code}"),
    "-X",
    init.method,
    "-H",
    shellQuote(`Authorization: Bearer ${token()}`),
    "-H",
    shellQuote("content-type: application/json"),
    bodyFlag,
    shellQuote(`http://127.0.0.1:4789${path}`),
  ].join(" ");
  const result = await ssh(command);
  expect(
    result.code,
    `${init.method} ${path} exits cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  const marker = "\n__HTTP_STATUS__:";
  const markerIndex = result.stdout.lastIndexOf(marker);
  expect(markerIndex, `${init.method} ${path} printed an HTTP status`).toBeGreaterThanOrEqual(0);
  const text = result.stdout.slice(0, markerIndex);
  const status = Number(result.stdout.slice(markerIndex + marker.length).trim());
  return { status, body: (text.length > 0 ? JSON.parse(text) : null) as T, text };
};

const expectGuestRequest = async <T>(
  path: string,
  init: { readonly method: "POST" | "DELETE"; readonly body?: unknown },
  timeoutSeconds?: number,
): Promise<T> => {
  const result = await guestRequest<T>(path, init, timeoutSeconds);
  expect(result.status, `${init.method} ${path}: ${result.text}`).toBe(200);
  return result.body;
};

const deleteSource = (slug: string): Effect.Effect<void> =>
  Effect.promise(() =>
    expectGuestRequest(`/api/apps/sources/${slug}`, { method: "DELETE" }).then(() => undefined),
  ).pipe(Effect.ignore);

const syncAndInvoke = (input: {
  readonly slug: string;
  readonly path: string;
}): Effect.Effect<void> =>
  Effect.promise(async () => {
    await expectGuestRequest("/api/apps/sources", {
      method: "POST",
      body: {
        kind: "local-directory",
        slug: input.slug,
        app: input.slug,
        path: input.path,
      },
    });

    const sync = await expectGuestRequest<SyncResponse>(
      `/api/apps/sources/${input.slug}/sync`,
      { method: "POST" },
      180,
    );
    expect(sync.status, "the desktop sidecar bundled and published the tool").toBe("published");
    expect(sync.tools, "the desktop sidecar bundled and published the tool").toContain("greet");

    const execution = await expectGuestRequest<ExecuteResponse>("/api/executions", {
      method: "POST",
      body: {
        code: `export default await tools["${input.slug}.org.published.greet"]({ name: "Ada" })`,
        autoApprove: true,
      },
    });
    expect(
      JSON.stringify(execution.structured ?? execution.text),
      "the published tool executes and returns the greeting",
    ).toContain('"greeting":"hello Ada"');
  });

if (!guestIp) {
  it.skip(`${NAME} (needs a desktop guest with E2E_DESKTOP_VM_IP)`, () => {});
} else if (os === "windows") {
  it.skip(`${NAME} (desktop-windows does not boot a sidecar daemon with a known token; use cli-windows)`, () => {});
} else {
  scenario(
    "Desktop sidecar · local-directory custom tool publishes and executes",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const slug = `sidecar-smoke-${crypto.randomUUID().slice(0, 8)}`;
      const path = fixturePath(slug);

      yield* Effect.promise(() => writeFixture(path)).pipe(
        Effect.andThen(syncAndInvoke({ slug, path })),
        Effect.ensuring(
          Effect.all([deleteSource(slug), removeFixture(path)], {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      );
    }),
  );
}
