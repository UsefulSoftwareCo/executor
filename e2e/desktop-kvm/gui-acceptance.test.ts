// One watched product journey in a disposable Linux KVM guest: the real
// packaged desktop switches two bearer accounts at one remote origin, keeps a
// remote account active across restart, then exposes its local MCP to the real
// pinned Claude Code binary with deterministic loopback-only model replay.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "@effect/vitest";

import { writeJsonAtomicSync } from "../src/artifact-io";
import { writeClaudeCodeEvidence } from "../src/clients/claude-code-evidence";
import { PackagedDesktopPage } from "../src/desktop/packaged";
import { writeFocusedTestSource } from "../src/test-source";
import { buildManifest } from "../src/viewer/manifest";
import { connectLinuxKvmGuest } from "../src/vm/linux-kvm-libvirt";
import type { LinuxKvmGuestConnection } from "../src/vm/linux-kvm";
import {
  KVM_ACCOUNT_FIXTURES,
  KVM_CLAUDE_EXPECTED_RESULT,
  KVM_REPLAY_API_KEY,
  isLoopbackHttpUrl,
  type KvmGuestClaudeResult,
  type KvmGuestRuntimeState,
} from "./guest-runtime";

const SCENARIO_NAME =
  "Desktop KVM · bearer accounts survive remote-active restart and real Claude uses local MCP";

interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

interface RunningDesktop {
  readonly page: PackagedDesktopPage;
  readonly pid: string;
}

interface PersistedProfile {
  readonly kind: string;
  readonly key: string;
  readonly origin: string;
  readonly displayName: string;
  readonly token: string | null;
}

interface PersistedProfileSnapshot {
  readonly activeKey: string | null;
  readonly profiles: ReadonlyArray<PersistedProfile>;
}

interface AccountLedgerEntry {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

interface ReplayLedger {
  readonly requests: ReadonlyArray<{
    readonly path: string;
    readonly toolNames: ReadonlyArray<string>;
    readonly messages: ReadonlyArray<{
      readonly toolResults: ReadonlyArray<{
        readonly content: string;
        readonly isError: boolean;
      }>;
    }>;
  }>;
  readonly errors: ReadonlyArray<string>;
}

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`desktop KVM setup did not publish ${name}`);
  return value;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cdpTargets = (value: unknown): ReadonlyArray<CdpTarget> => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !isUnknownRecord(candidate) ||
      typeof candidate.type !== "string" ||
      typeof candidate.url !== "string"
    ) {
      return [];
    }
    return [
      {
        type: candidate.type,
        url: candidate.url,
        ...(typeof candidate.webSocketDebuggerUrl === "string"
          ? { webSocketDebuggerUrl: candidate.webSocketDebuggerUrl }
          : {}),
      },
    ];
  });
};

const readText = (url: string) =>
  new Promise<string>((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(body);
        } else {
          // oxlint-disable-next-line executor/no-promise-reject -- boundary: node:http callback adapter for the external CDP endpoint
          reject(new Error(`CDP target list returned ${response.statusCode}: ${body}`));
        }
      });
    });
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("CDP target list timed out")));
  });

const waitForPage = async (localPort: number) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const targets = await readText(`http://127.0.0.1:${localPort}/json/list`)
      .then((body) => cdpTargets(JSON.parse(body)))
      .catch(() => []);
    const target = targets.find(
      (candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl &&
        !candidate.url.startsWith("devtools://"),
    );
    if (target?.webSocketDebuggerUrl) {
      const endpoint = new URL(target.webSocketDebuggerUrl);
      endpoint.hostname = "127.0.0.1";
      endpoint.port = String(localPort);
      return PackagedDesktopPage.connect(endpoint.toString());
    }
    if (Date.now() >= deadline) throw new Error("packaged app did not publish a CDP page");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const launchDesktop = async (input: {
  readonly guest: LinuxKvmGuestConnection;
  readonly display: string;
  readonly remoteApp: string;
  readonly remoteHome: string;
  readonly appLog: string;
  readonly localCdpPort: number;
  readonly cleanHome: boolean;
}) => {
  const directories = [
    input.remoteHome,
    `${input.remoteHome}/.config`,
    `${input.remoteHome}/.cache`,
    `${input.remoteHome}/.local/share`,
    `${input.remoteHome}/.xdg-runtime`,
  ];
  const launch = await input.guest.run(
    [
      ...(input.cleanHome ? [`rm -rf ${shellQuote(input.remoteHome)}`] : []),
      `mkdir -p ${directories.map(shellQuote).join(" ")}`,
      `chmod 700 ${shellQuote(`${input.remoteHome}/.xdg-runtime`)}`,
      `nohup env DISPLAY=${shellQuote(input.display)} HOME=${shellQuote(input.remoteHome)} XDG_CONFIG_HOME=${shellQuote(`${input.remoteHome}/.config`)} XDG_CACHE_HOME=${shellQuote(`${input.remoteHome}/.cache`)} XDG_DATA_HOME=${shellQuote(`${input.remoteHome}/.local/share`)} XDG_RUNTIME_DIR=${shellQuote(`${input.remoteHome}/.xdg-runtime`)} ELECTRON_ENABLE_LOGGING=1 ${shellQuote(input.remoteApp)} --no-sandbox --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --remote-allow-origins='*' >>${shellQuote(input.appLog)} 2>&1 < /dev/null &`,
      "echo $!",
    ].join("; "),
  );
  if (launch.code !== 0 || !/^\d+$/.test(launch.stdout.trim())) {
    throw new Error(`packaged app launch failed: ${launch.stderr || launch.stdout}`);
  }
  const page = await waitForPage(input.localCdpPort);
  await page.command("Runtime.enable");
  await page.command("Page.enable");
  await page.waitForText("Settings", 180_000);
  return { page, pid: launch.stdout.trim() } satisfies RunningDesktop;
};

const stopDesktop = async (guest: LinuxKvmGuestConnection, app: RunningDesktop | undefined) => {
  if (!app) return;
  app.page.close();
  const stopped = await guest.run(
    `kill -TERM ${app.pid} 2>/dev/null || true; for attempt in $(seq 1 100); do kill -0 ${app.pid} 2>/dev/null || exit 0; sleep 0.1; done; kill -KILL ${app.pid} 2>/dev/null || true`,
  );
  if (stopped.code !== 0) throw new Error(`packaged app did not stop: ${stopped.stderr}`);
};

const waitForServerConnectionLabel = async (
  page: PackagedDesktopPage,
  expectedText: string,
  timeoutMs: number,
) => {
  const deadline = Date.now() + timeoutMs;
  let label = "";
  for (;;) {
    label = await page
      .evaluate<string>(
        `document.querySelector('[aria-label^="Select Executor server:"]')?.getAttribute('aria-label') ?? ""`,
      )
      .catch(() => "");
    if (label.includes(expectedText)) return label;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for server connection label ${expectedText}; last=${label}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const openServerProfiles = async (page: PackagedDesktopPage) => {
  const alreadyOpen = await page.evaluate<boolean>(
    `document.querySelector('[data-slot="popover-content"][data-state="open"]') !== null`,
  );
  const opened =
    alreadyOpen ||
    (await page.evaluate<boolean>(`(() => {
      const trigger = document.querySelector('[aria-label^="Select Executor server:"]');
      if (!(trigger instanceof HTMLButtonElement)) return false;
      trigger.click();
      return true;
    })()`));
  expect(opened, "the packaged desktop app exposes the server profile trigger").toBe(true);
  await page.waitForExpression(
    `document.querySelector('[data-slot="popover-content"][data-state="open"]')?.textContent?.includes("Server profiles")`,
    30_000,
    "the server profiles popover",
  );
};

const closeServerProfiles = async (page: PackagedDesktopPage) => {
  const open = await page.evaluate<boolean>(
    `document.querySelector('[data-slot="popover-content"][data-state="open"]') !== null`,
  );
  if (!open) return;
  const clicked = await page.evaluate<boolean>(`(() => {
    const trigger = document.querySelector('[aria-label^="Select Executor server:"]');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(clicked, "the server profile trigger closes its popover").toBe(true);
  await page.waitForExpression(
    `document.querySelector('[data-slot="popover-content"][data-state="open"]') === null`,
    30_000,
    "the server profiles popover to close",
  );
};

const serverProfileRowText = async (page: PackagedDesktopPage, name: string) => {
  await openServerProfiles(page);
  await page.waitForExpression(
    `document.querySelector('[data-slot="popover-content"][data-state="open"]')?.textContent?.includes(${JSON.stringify(name)})`,
    30_000,
    `the ${name} profile row`,
  );
  return page.evaluate<string>(`(() => {
    const content = document.querySelector('[data-slot="popover-content"][data-state="open"]');
    const button = Array.from(content?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent?.includes(${JSON.stringify(name)}),
    );
    return button?.parentElement?.textContent ?? "";
  })()`);
};

const clickServerProfileButton = async (page: PackagedDesktopPage, text: string) => {
  const clicked = await page.evaluate<boolean>(`(() => {
    const content = document.querySelector('[data-slot="popover-content"][data-state="open"]');
    if (!(content instanceof HTMLElement)) return false;
    const expected = ${JSON.stringify(text)};
    const button = Array.from(content.querySelectorAll("button")).find(
      (candidate) => candidate.getClientRects().length > 0 && candidate.textContent?.includes(expected),
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(clicked, `the server profiles popover contains ${text}`).toBe(true);
};

const setServerProfileControl = async (
  page: PackagedDesktopPage,
  selector: string,
  value: string,
) => {
  const changed = await page.evaluate<boolean>(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    const nextValue = ${JSON.stringify(value)};
    const prototype = control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : control instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
    if (!control || !setter) return false;
    setter.call(control, nextValue);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  expect(changed, `the server profile form exposes ${selector}`).toBe(true);
};

const addServerProfile = async (
  page: PackagedDesktopPage,
  input: { readonly origin: string; readonly name: string; readonly token: string },
) => {
  await openServerProfiles(page);
  await clickServerProfileButton(page, "Custom server");
  await page.waitForExpression(
    `document.querySelector('input[placeholder="https://executor.example"]') !== null`,
    30_000,
    "the custom server form",
  );
  await setServerProfileControl(
    page,
    'input[placeholder="https://executor.example"]',
    input.origin,
  );
  await setServerProfileControl(page, 'input[placeholder="Remote executor"]', input.name);
  await setServerProfileControl(page, "form select", "bearer");
  await page.waitForExpression(
    `document.querySelector('form input[type="password"]') !== null`,
    30_000,
    "the bearer token input",
  );
  await setServerProfileControl(page, 'form input[type="password"]', input.token);
  await clickServerProfileButton(page, "Add and use");
  await waitForServerConnectionLabel(page, input.name, 30_000);
};

const selectServerProfile = async (page: PackagedDesktopPage, name: string) => {
  await openServerProfiles(page);
  await page.waitForExpression(
    `document.querySelector('[data-slot="popover-content"][data-state="open"]')?.textContent?.includes(${JSON.stringify(name)})`,
    30_000,
    `the ${name} profile to hydrate`,
  );
  await clickServerProfileButton(page, name);
  await waitForServerConnectionLabel(page, name, 30_000);
};

const expectIntegrationAccount = async (
  page: PackagedDesktopPage,
  expected: string,
  rejected: string,
) => {
  await page.waitForText(expected, 30_000);
  expect(await page.textPresent(rejected), `${expected} does not render ${rejected}`).toBe(false);
};

const readPersistedProfiles = (page: PackagedDesktopPage) =>
  page.evaluate<PersistedProfileSnapshot>(`(() => {
    const bridge = window.executor;
    if (!bridge?.getServerProfiles) return { activeKey: null, profiles: [] };
    return bridge.getServerProfiles().then((raw) => {
      const snapshot = JSON.parse(raw ?? '{"profiles":[]}');
      return {
        activeKey: snapshot.activeKey ?? null,
        profiles: (snapshot.profiles ?? []).map((profile) => ({
          kind: profile.kind ?? "",
          key: profile.key ?? "",
          origin: profile.origin ?? "",
          displayName: profile.displayName ?? "",
          token: profile.auth?.kind === "bearer" ? profile.auth.token : null,
        })),
      };
    });
  })()`);

const waitForPersistedProfiles = async (
  page: PackagedDesktopPage,
  names: ReadonlyArray<string>,
) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshot = await readPersistedProfiles(page);
    if (names.every((name) => snapshot.profiles.some((profile) => profile.displayName === name))) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for persisted profiles: ${names.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const guestJson = async (guest: LinuxKvmGuestConnection, path: string) => {
  const result = await guest.run(`cat ${shellQuote(path)}`);
  if (result.code !== 0) throw new Error(`could not read guest JSON ${path}: ${result.stderr}`);
  const decoded: unknown = JSON.parse(result.stdout);
  return decoded;
};

const runtimeState = (value: unknown): KvmGuestRuntimeState => {
  if (
    !isUnknownRecord(value) ||
    typeof value.pid !== "number" ||
    typeof value.accountOrigin !== "string" ||
    typeof value.brainOrigin !== "string" ||
    typeof value.accountLedgerPath !== "string" ||
    typeof value.replayLedgerPath !== "string"
  ) {
    throw new Error("guest runtime published an invalid state document");
  }
  return {
    pid: value.pid,
    accountOrigin: value.accountOrigin,
    brainOrigin: value.brainOrigin,
    accountLedgerPath: value.accountLedgerPath,
    replayLedgerPath: value.replayLedgerPath,
  };
};

const claudeResult = (value: unknown): KvmGuestClaudeResult => {
  if (
    !isUnknownRecord(value) ||
    typeof value.binaryPath !== "string" ||
    typeof value.expectedVersion !== "string" ||
    typeof value.durationMs !== "number" ||
    (typeof value.exitCode !== "number" && value.exitCode !== null) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    value.mcpServerName !== "executor" ||
    typeof value.mcpOrigin !== "string" ||
    typeof value.replayOrigin !== "string"
  ) {
    throw new Error("guest Claude runner published an invalid result document");
  }
  return {
    binaryPath: value.binaryPath,
    expectedVersion: value.expectedVersion,
    ...(typeof value.observedVersion === "string"
      ? { observedVersion: value.observedVersion }
      : {}),
    durationMs: value.durationMs,
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
    ...(value.structuredResult === undefined ? {} : { structuredResult: value.structuredResult }),
    mcpServerName: "executor",
    mcpOrigin: value.mcpOrigin,
    replayOrigin: value.replayOrigin,
  };
};

const stringArray = (value: unknown, label: string) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} must contain only strings`);
    return entry;
  });
};

const replayLedger = (value: unknown): ReplayLedger => {
  if (!isUnknownRecord(value) || !Array.isArray(value.requests)) {
    throw new Error("guest replay ledger is invalid");
  }
  const errors = stringArray(value.errors, "guest replay errors");
  const requests = value.requests.map((request) => {
    if (!isUnknownRecord(request) || typeof request.path !== "string") {
      throw new Error("guest replay request is invalid");
    }
    if (!Array.isArray(request.messages)) {
      throw new Error("guest replay request messages are invalid");
    }
    const messages = request.messages.map((message) => {
      if (!isUnknownRecord(message) || !Array.isArray(message.toolResults)) {
        throw new Error("guest replay message is invalid");
      }
      const toolResults = message.toolResults.map((result) => {
        if (
          !isUnknownRecord(result) ||
          typeof result.content !== "string" ||
          typeof result.isError !== "boolean"
        ) {
          throw new Error("guest replay tool result is invalid");
        }
        return { content: result.content, isError: result.isError };
      });
      return { toolResults };
    });
    return {
      path: request.path,
      toolNames: stringArray(request.toolNames, "guest replay tool names"),
      messages,
    };
  });
  return { requests, errors };
};

const accountLedger = (value: unknown): ReadonlyArray<AccountLedgerEntry> => {
  if (!Array.isArray(value)) throw new Error("guest account ledger is invalid");
  return value.map((request) => {
    if (
      !isUnknownRecord(request) ||
      typeof request.method !== "string" ||
      typeof request.url !== "string" ||
      (typeof request.authorization !== "string" && request.authorization !== null)
    ) {
      throw new Error("guest account ledger entry is invalid");
    }
    return {
      method: request.method,
      url: request.url,
      authorization: request.authorization,
    };
  });
};

const localDesktopMcp = (page: PackagedDesktopPage) =>
  page.evaluate<{ readonly origin: string; readonly token: string } | null>(`(() => {
    return Promise.all([
      window.executor.getServerConnection(),
      window.executor.getServerAuthToken(),
    ]).then(([connection, token]) => connection && token
      ? { origin: connection.origin, token }
      : null);
  })()`);

it(SCENARIO_NAME, { timeout: 480_000 }, async () => {
  const artifactDir = env("E2E_KVM_ARTIFACT_DIR");
  writeFocusedTestSource({
    runDir: artifactDir,
    filePath: fileURLToPath(import.meta.url),
    testName: SCENARIO_NAME,
  });
  const display = env("E2E_KVM_GUEST_DISPLAY");
  const guestHost = env("E2E_KVM_GUEST_HOST");
  const remoteApp = env("E2E_KVM_REMOTE_APP");
  const remoteBun = env("E2E_KVM_REMOTE_BUN");
  const remoteClaude = env("E2E_KVM_REMOTE_CLAUDE");
  const remoteGuestRuntime = env("E2E_KVM_REMOTE_GUEST_RUNTIME");
  const remoteHome = env("E2E_KVM_REMOTE_HOME");
  const recordingPath = env("E2E_KVM_RECORDING_PATH");
  const expectedClaudeVersion = env("E2E_KVM_CLAUDE_CODE_VERSION");
  const localCdpPort = Number.parseInt(env("E2E_KVM_CDP_PORT"), 10);
  const guest = connectLinuxKvmGuest({
    host: guestHost,
    keyPath: env("E2E_KVM_SSH_KEY"),
    user: env("E2E_KVM_GUEST_USER"),
  });
  const appLog = `${remoteHome}/app.log`;
  const runtimeDir = `${remoteHome}/guest-runtime`;
  const runtimeLog = `${runtimeDir}.log`;
  let app: RunningDesktop | undefined;
  let fixturePid: number | undefined;
  let failure: unknown;
  let cleanupFailure: unknown;
  let passed = false;
  const startedAt = Date.now();

  try {
    app = await launchDesktop({
      guest,
      display,
      remoteApp,
      remoteHome,
      appLog,
      localCdpPort,
      cleanHome: true,
    });
    await waitForServerConnectionLabel(app.page, "Local Executor", 120_000);

    const fixtureStart = await guest.run(
      `nohup ${shellQuote(remoteBun)} ${shellQuote(remoteGuestRuntime)} serve --state-dir ${shellQuote(runtimeDir)} --account-host ${shellQuote(guestHost)} >${shellQuote(runtimeLog)} 2>&1 < /dev/null & echo $!`,
    );
    expect(fixtureStart.code, `guest fixtures failed to launch: ${fixtureStart.stderr}`).toBe(0);
    expect(fixtureStart.stdout.trim()).toMatch(/^\d+$/);
    fixturePid = Number.parseInt(fixtureStart.stdout.trim(), 10);

    let state: KvmGuestRuntimeState | undefined;
    for (let attempt = 0; attempt < 120 && !state; attempt++) {
      state = await guestJson(guest, `${runtimeDir}/runtime.json`)
        .then(runtimeState)
        .catch(() => undefined);
      if (!state) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!state) throw new Error("guest fixtures did not publish runtime state");
    expect(new URL(state.accountOrigin).hostname, "account fixture is classified as remote").toBe(
      guestHost,
    );
    expect(new URL(state.brainOrigin).hostname, "model replay stays inside guest loopback").toBe(
      "127.0.0.1",
    );

    const [accountA, accountB] = KVM_ACCOUNT_FIXTURES;
    await addServerProfile(app.page, {
      origin: state.accountOrigin,
      name: accountA.name,
      token: accountA.token,
    });
    await expectIntegrationAccount(app.page, accountA.marker, accountB.marker);
    await closeServerProfiles(app.page);
    await app.page.screenshot(join(artifactDir, "01-account-a-catalog.png"));

    await addServerProfile(app.page, {
      origin: state.accountOrigin,
      name: accountB.name,
      token: accountB.token,
    });
    await expectIntegrationAccount(app.page, accountB.marker, accountA.marker);
    await closeServerProfiles(app.page);
    await app.page.screenshot(join(artifactDir, "02-account-b-catalog.png"));

    await selectServerProfile(app.page, accountA.name);
    await expectIntegrationAccount(app.page, accountA.marker, accountB.marker);
    const accountARow = await serverProfileRowText(app.page, accountA.name);
    expect(accountARow, "the non-loopback account is visibly classified as remote").toContain(
      "Remote",
    );
    await closeServerProfiles(app.page);
    await app.page.screenshot(join(artifactDir, "03-account-a-restored.png"));

    const beforeRestart = await waitForPersistedProfiles(app.page, [accountA.name, accountB.name]);
    const profileA = beforeRestart.profiles.find(
      (profile) => profile.displayName === accountA.name,
    );
    const profileB = beforeRestart.profiles.find(
      (profile) => profile.displayName === accountB.name,
    );
    expect(profileA).toMatchObject({ origin: state.accountOrigin, token: accountA.token });
    expect(profileB).toMatchObject({ origin: state.accountOrigin, token: accountB.token });
    expect(profileA?.kind).toBe("http");
    expect(profileB?.kind).toBe("http");
    expect(
      beforeRestart.profiles.some((profile) => profile.kind === "desktop-sidecar"),
      "the local sidecar remains persisted while account A is active",
    ).toBe(true);
    expect(profileA?.key).not.toBe(profileB?.key);
    expect(beforeRestart.activeKey, "account A is active before the restart").toBe(profileA?.key);

    await stopDesktop(guest, app);
    app = undefined;
    app = await launchDesktop({
      guest,
      display,
      remoteApp,
      remoteHome,
      appLog,
      localCdpPort,
      cleanHome: false,
    });
    await waitForServerConnectionLabel(app.page, accountA.name, 120_000);
    await expectIntegrationAccount(app.page, accountA.marker, accountB.marker);
    const afterRestart = await waitForPersistedProfiles(app.page, [accountA.name, accountB.name]);
    expect(afterRestart.activeKey, "the remote account remains active after restart").toBe(
      profileA?.key,
    );
    expect(
      afterRestart.profiles.some((profile) => profile.kind === "desktop-sidecar"),
      "the local sidecar remains persisted after restoring the remote account",
    ).toBe(true);
    expect(
      afterRestart.profiles.filter(
        (profile) => profile.displayName === accountA.name || profile.displayName === accountB.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "http",
          key: profileA?.key,
          origin: state.accountOrigin,
          displayName: accountA.name,
          token: accountA.token,
        }),
        expect.objectContaining({
          kind: "http",
          key: profileB?.key,
          origin: state.accountOrigin,
          displayName: accountB.name,
          token: accountB.token,
        }),
      ]),
    );
    const restartedAccountARow = await serverProfileRowText(app.page, accountA.name);
    expect(
      restartedAccountARow,
      "the restored active account remains visibly classified as remote",
    ).toContain("Remote");
    await app.page.screenshot(join(artifactDir, "04-remote-profile-after-restart.png"));
    await closeServerProfiles(app.page);

    await selectServerProfile(app.page, "Local Executor");
    await closeServerProfiles(app.page);
    await app.page.waitForExpression(
      `!document.body?.innerText.includes(${JSON.stringify(accountA.marker)}) &&
       !document.body?.innerText.includes(${JSON.stringify(accountB.marker)})`,
      30_000,
      "the local sidecar catalog to replace remote account data",
    );
    const localMcp = await localDesktopMcp(app.page);
    expect(
      localMcp,
      "the desktop exposes its real local MCP bearer to Connect an agent",
    ).not.toBeNull();
    if (!localMcp) throw new Error("local desktop MCP connection disappeared");
    const mcpUrl = new URL("/mcp", localMcp.origin).toString();
    expect(isLoopbackHttpUrl(mcpUrl), "Claude can reach MCP without leaving guest loopback").toBe(
      true,
    );

    const remoteClaudeConfig = `${runtimeDir}/claude-run.json`;
    const remoteClaudeOutput = `${runtimeDir}/claude-result.json`;
    const localSecretDir = mkdtempSync(join(tmpdir(), "executor-kvm-claude-config-"));
    const localClaudeConfig = join(localSecretDir, "config.json");
    try {
      writeFileSync(
        localClaudeConfig,
        `${JSON.stringify({
          binaryPath: remoteClaude,
          expectedVersion: expectedClaudeVersion,
          homeDir: `${runtimeDir}/claude-home`,
          mcpUrl,
          authorizationHeader: `Bearer ${localMcp.token}`,
          brainBaseUrl: state.brainOrigin,
          outputPath: remoteClaudeOutput,
        })}\n`,
        { mode: 0o600 },
      );
      await guest.push(localClaudeConfig, remoteClaudeConfig);
    } finally {
      rmSync(localSecretDir, { force: true, recursive: true });
    }
    const claudeInvocation = await guest.run(
      `chmod 600 ${shellQuote(remoteClaudeConfig)} && ${shellQuote(remoteBun)} ${shellQuote(remoteGuestRuntime)} claude ${shellQuote(remoteClaudeConfig)}`,
    );
    const realClaude = claudeResult(await guestJson(guest, remoteClaudeOutput));
    expect(claudeInvocation.code, `real Claude Code failed: ${realClaude.stderr}`).toBe(0);
    expect(realClaude.exitCode).toBe(0);
    expect(realClaude.binaryPath).toBe(remoteClaude);
    expect(realClaude.observedVersion).toBe(expectedClaudeVersion);
    expect(realClaude.mcpOrigin).toBe(new URL(mcpUrl).origin);
    expect(realClaude.replayOrigin).toBe(new URL(state.brainOrigin).origin);
    expect(realClaude.stdout, "Claude returns Executor's real execute result").toContain(
      KVM_CLAUDE_EXPECTED_RESULT,
    );
    expect(
      isUnknownRecord(realClaude.structuredResult) &&
        typeof realClaude.structuredResult.result === "string" &&
        realClaude.structuredResult.result.includes(KVM_CLAUDE_EXPECTED_RESULT),
      "Claude's structured result contains the value returned by Executor",
    ).toBe(true);

    const replay = replayLedger(await guestJson(guest, state.replayLedgerPath));
    expect(replay.errors).toEqual([]);
    expect(
      replay.requests.some((request) =>
        request.toolNames.some((name) => name.endsWith("__execute")),
      ),
      "Claude discovered Executor execute through the desktop MCP",
    ).toBe(true);
    expect(
      replay.requests
        .flatMap((request) => request.messages)
        .flatMap((message) => message.toolResults)
        .some((result) => !result.isError && result.content.includes(KVM_CLAUDE_EXPECTED_RESULT)),
      "the real MCP result returned to the loopback model boundary",
    ).toBe(true);

    const remoteAccountRequests = accountLedger(await guestJson(guest, state.accountLedgerPath));
    const integrationAuthorizations = remoteAccountRequests
      .filter(
        (request) =>
          request.method === "GET" &&
          new URL(request.url, state.accountOrigin).pathname === "/api/integrations",
      )
      .map((request) => request.authorization);
    expect(integrationAuthorizations).toContain(`Bearer ${accountA.token}`);
    expect(integrationAuthorizations).toContain(`Bearer ${accountB.token}`);
    expect(
      integrationAuthorizations.every(
        (authorization) =>
          authorization === `Bearer ${accountA.token}` ||
          authorization === `Bearer ${accountB.token}`,
      ),
      "the same-origin remote fixture never receives the local desktop bearer",
    ).toBe(true);

    writeJsonAtomicSync(join(artifactDir, "account-fixture-ledger.json"), remoteAccountRequests);
    writeJsonAtomicSync(join(artifactDir, "anthropic-replay-ledger.json"), replay);
    writeClaudeCodeEvidence(artifactDir, {
      label: "KVM guest Claude Code against packaged desktop local MCP",
      executable: realClaude.binaryPath,
      expectedVersion: realClaude.expectedVersion,
      observedVersion: realClaude.observedVersion,
      durationMs: realClaude.durationMs,
      status: realClaude.exitCode === 0 ? "success" : "failure",
      exitCode: realClaude.exitCode,
      stdout: realClaude.stdout,
      stderr: realClaude.stderr,
      structuredResult: realClaude.structuredResult,
      mcpServerName: realClaude.mcpServerName,
      mcpOrigin: realClaude.mcpOrigin,
      replayOrigin: realClaude.replayOrigin,
      replayRequestPaths: replay.requests.map((request) => request.path),
      replayErrors: replay.errors,
      secrets: [localMcp.token, accountA.token, accountB.token, KVM_REPLAY_API_KEY],
    });
    await app.page.screenshot(join(artifactDir, "05-claude-code-local-mcp.png"));

    expect(existsSync(recordingPath), "the SPICE recorder created its MP4 artifact").toBe(true);
    passed = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stopDesktop(guest, app);
      const logs = await guest.run(
        `tail -300 ${shellQuote(appLog)} 2>/dev/null || true; tail -200 ${shellQuote(runtimeLog)} 2>/dev/null || true`,
      );
      writeFileSync(join(artifactDir, "packaged-app.log"), `${logs.stdout}\n${logs.stderr}`);
      if (fixturePid) await guest.run(`kill -TERM ${fixturePid} 2>/dev/null || true`);
      await guest.run(`pkill -TERM -f ${shellQuote(remoteApp)} 2>/dev/null || true`);
    } catch (error) {
      cleanupFailure = error;
    }

    const endedAt = Date.now();
    const finalFailure = failure ?? cleanupFailure;
    writeJsonAtomicSync(join(artifactDir, "result.json"), {
      scenario: SCENARIO_NAME,
      target: "desktop-kvm",
      ok: passed && cleanupFailure === undefined,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      visualEvidence: { dataClassification: "synthetic-only" },
      ...(finalFailure ? { error: String(finalFailure) } : {}),
      artifacts: readdirSync(artifactDir).filter((name) => name !== "result.json"),
    });
    buildManifest(dirname(dirname(artifactDir)));
  }

  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
});
