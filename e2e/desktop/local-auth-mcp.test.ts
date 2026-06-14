// Desktop-only: the local bearer-auth model through the REAL Electron app +
// sidecar, covering the two flows a code review found the e2e suite missed:
//
//   A. MCP BROWSER APPROVAL (guards the resume-page bearer): an MCP client hits
//      a gated tool against the desktop's sidecar; the user approves in the
//      renderer; the agent's resume completes. This drives the whole desktop
//      bearer path — the renderer carries NO client-side token, so every
//      /api/mcp-sessions call (the session-scoped paused GET + the resume POST)
//      relies on the main process injecting the bearer at the session layer.
//
//   B. BEARER SCOPING (guards against the ambient-credential regression): a
//      NON-app BrowserWindow (what an OAuth popup is) issuing a request to the
//      sidecar's gated /api must NOT get the bearer auto-attached — it 401s —
//      while the app's own window does. Pre-fix the injection covered every
//      webContents in the session, so a popup could ride the bearer (CSRF).
//
// Both launch the real app via `_electron.launch` against a throwaway HOME and
// read the sidecar's origin + bearer from the on-disk manifest.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { _electron, type ElectronApplication } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

const APPROVAL_TARGET_TOOL = "executor.coreTools.policies.list";
const EXECUTE_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

interface SidecarConn {
  readonly origin: string;
  readonly token: string;
}

const launchDesktop = async (home: string, runDir: string): Promise<ElectronApplication> =>
  _electron.launch({
    executablePath: electronBinary,
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, HOME: home },
    recordVideo: { dir: join(runDir, ".video-tmp"), size: { width: 1280, height: 800 } },
    timeout: 120_000,
  });

// The sidecar writes server.json (origin + bearer) once it emits EXECUTOR_READY,
// which is exactly when firstWindow resolves — so this is always safe to read
// after the window is up.
const readSidecar = (home: string): SidecarConn => {
  const manifest = JSON.parse(
    readFileSync(join(home, ".executor/server-control/server.json"), "utf8"),
  ) as { connection: { origin: string; auth?: { token?: string } } };
  const origin = manifest.connection.origin;
  const token = manifest.connection.auth?.token;
  expect(typeof origin, "sidecar origin in the manifest").toBe("string");
  expect(typeof token, "sidecar bearer token in the manifest").toBe("string");
  return { origin, token: token! };
};

const closeWithVideo = async (app: ElectronApplication, runDir: string, home: string) => {
  const page = app.windows()[0];
  const video = page?.video();
  await app.close().catch(() => {});
  const recordedPath = await video?.path().catch(() => undefined);
  if (recordedPath && existsSync(recordedPath)) {
    await promisify(execFile)("ffmpeg", [
      "-y",
      "-i",
      recordedPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(runDir, "session.mp4"),
    ]).catch(() => {});
  }
  rmSync(join(runDir, ".video-tmp"), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
};

// ---------------------------------------------------------------------------
// A. MCP browser approval through the desktop app
// ---------------------------------------------------------------------------

scenario(
  "Desktop · MCP browser approval: gated tool, approve in the app, resume completes",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => runApproval(runDir));
  }),
);

const runApproval = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-desktop-mcp-"));
  const app = await launchDesktop(home, runDir);
  let stepIndex = 0;
  try {
    const page = await app.firstWindow({ timeout: 120_000 });
    const step = async (label: string, body: () => Promise<void>) => {
      await body();
      stepIndex += 1;
      await page.screenshot({
        path: join(
          runDir,
          `${String(stepIndex).padStart(2, "0")}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
        ),
      });
    };

    await step("app boots into the web console", async () => {
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    const { origin, token } = readSidecar(home);

    // Plant a require_approval policy so the gated tool elicits (bearer-authed —
    // the test process is not the app, so it carries the token explicitly).
    const policyRes = await fetch(`${origin}/api/policies`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        owner: "org",
        pattern: APPROVAL_TARGET_TOOL,
        action: "require_approval",
      }),
    });
    expect(policyRes.ok, `policy create ok (${policyRes.status})`).toBe(true);

    const mcp = new Client({ name: "e2e-desktop-approve", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp?elicitation_mode=browser`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    await mcp.connect(transport);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the test owns the MCP transport lifecycle
    try {
      const executed = await mcp.callTool({ name: "execute", arguments: { code: EXECUTE_CODE } });
      const paused = executed.structuredContent as {
        status: string;
        executionId: string;
        approvalUrl: string;
      };
      expect(paused.status, "execute paused for browser approval").toBe("user_approval_required");

      await step("approve the gated tool in the desktop renderer", async () => {
        // The renderer carries no token; the main process injects the bearer for
        // THIS window. No ?_token (bootstrap no-ops on desktop).
        await page.goto(paused.approvalUrl, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30_000 });
        expect(
          await page.getByText("This paused execution is no longer available").count(),
          "approval page loaded the paused execution (session-injected bearer reached the gated GET)",
        ).toBe(0);
        await page.getByRole("button", { name: "Approve" }).click();
        await page.getByText("Approve sent").waitFor({ timeout: 15_000 });
      });

      const resumed = await mcp.callTool({
        name: "resume",
        arguments: { executionId: paused.executionId },
      });
      expect(
        (resumed.structuredContent as { status: string }).status,
        "resume completed after the in-app approval",
      ).toBe("completed");
    } finally {
      await mcp.close();
    }
  } finally {
    await closeWithVideo(app, runDir, home);
  }
};

// ---------------------------------------------------------------------------
// B. Bearer scoping: a non-app webContents does NOT get the bearer
// ---------------------------------------------------------------------------

scenario(
  "Desktop · the bearer is scoped to the app window — a popup webContents gets 401",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => runBearerScoping(runDir));
  }),
);

const runBearerScoping = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-desktop-scope-"));
  const app = await launchDesktop(home, runDir);
  try {
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.getByText("Settings").first().waitFor({ timeout: 120_000 });

    const { origin } = readSidecar(home);
    const gatedUrl = `${origin}/api/scope`;

    // The app's OWN window: the main process injects the bearer → not 401.
    const mainStatus = await page.evaluate(
      (url) =>
        fetch(url)
          .then((r) => r.status)
          .catch(() => -1),
      gatedUrl,
    );
    expect(mainStatus, "app window: injected bearer reaches the gated endpoint").not.toBe(401);

    // A non-app BrowserWindow (what an OAuth popup is) in the SAME session: its
    // requests to the sidecar must NOT get the bearer auto-attached → 401.
    const popupStatus = await app.evaluate(
      async ({ BrowserWindow }, { origin: o, gatedUrl: g }) => {
        const popup = new BrowserWindow({
          show: false,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        // Load the SPA (served unauthenticated) so the fetch has the right origin.
        await popup.loadURL(`${o}/`);
        const status = await popup.webContents.executeJavaScript(
          `fetch(${JSON.stringify(g)}).then((r) => r.status).catch(() => -1)`,
        );
        popup.destroy();
        return status as number;
      },
      { origin, gatedUrl },
    );
    expect(popupStatus, "popup webContents: no bearer injected → gated endpoint rejects it").toBe(
      401,
    );

    await page.screenshot({ path: join(runDir, "01-bearer-scoping.png") });
  } finally {
    await closeWithVideo(app, runDir, home);
  }
};
