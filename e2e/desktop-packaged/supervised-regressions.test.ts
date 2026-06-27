// Packaged desktop supervised-daemon regressions. These run against the real
// electron-builder bundle and its bundled executor because the supervised attach
// path is production-only (`app.isPackaged`).
import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import net from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  normalizeExecutorServerConnection,
  serializeExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";

import {
  closePackagedDesktop,
  createPackagedDesktopHome,
  freePort,
  launchPackagedDesktop,
  packagedDesktopPreflight,
  packagedDesktopSettingsDir,
  reconnectPackagedDesktopPage,
  removePackagedDesktopHome,
  requirePackagedDesktopBundle,
  startSupervisedDaemon,
  stopProcess,
  type PackagedDesktopApp,
  type PackagedDesktopPage,
} from "../src/desktop/packaged";
import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { waitForHttp } from "../setup/boot";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "sh.executor.daemon";

const nonLoopbackIpv4Address = () => {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal);
  return (
    addresses.find((entry) => !entry.address.startsWith("169.254."))?.address ??
    addresses[0]?.address ??
    null
  );
};

const currentUid = (): number => {
  const getuid = (process as { readonly getuid?: () => number }).getuid;
  return typeof getuid === "function" ? getuid.call(process) : 0;
};

const serviceTarget = (): string => `gui/${currentUid()}/${SERVICE_LABEL}`;
const launchAgentPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const desktopSettingsDirs = (home: string): readonly string[] => {
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      packagedDesktopSettingsDir(home),
      join(support, "@executor-js", "desktop"),
      join(support, "Executor"),
    ];
  }
  if (process.platform === "linux") {
    return [
      packagedDesktopSettingsDir(home),
      join(home, ".config", "@executor-js", "desktop"),
      join(home, ".config", "Executor"),
    ];
  }
  const roaming = join(home, "AppData", "Roaming");
  return [
    packagedDesktopSettingsDir(home),
    join(roaming, "@executor-js", "desktop"),
    join(roaming, "Executor"),
  ];
};

interface LaunchdServiceSnapshot {
  readonly plist: string | null;
  readonly wasLoaded: boolean;
}

const launchctl = async (args: ReadonlyArray<string>): Promise<boolean> => {
  try {
    await execFileAsync("launchctl", [...args]);
    return true;
  } catch {
    return false;
  }
};

const captureLaunchdService = (): LaunchdServiceSnapshot | null => {
  if (process.platform !== "darwin") return null;
  const path = launchAgentPath();
  const plist = existsSync(path) ? readFileSync(path, "utf8") : null;
  let wasLoaded = false;
  try {
    execFileSync("launchctl", ["print", serviceTarget()], { stdio: "ignore" });
    wasLoaded = true;
  } catch {
    wasLoaded = false;
  }
  return { plist, wasLoaded };
};

const restoreLaunchdService = async (snapshot: LaunchdServiceSnapshot | null): Promise<void> => {
  if (!snapshot) return;
  const target = serviceTarget();
  await launchctl(["bootout", target]);
  const path = launchAgentPath();
  if (snapshot.plist === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, snapshot.plist, { mode: 0o600 });
  chmodSync(path, 0o600);
  await launchctl(["enable", target]);
  if (snapshot.wasLoaded) {
    const bootstrapped = await launchctl(["bootstrap", `gui/${currentUid()}`, path]);
    if (bootstrapped) await launchctl(["kickstart", "-k", target]);
  }
};

const waitForServerConnectionLabel = async (
  page: PackagedDesktopPage,
  expectedText: string,
  timeoutMs: number,
): Promise<string> => {
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

const settingsScrollFrameExpression = `(() => {
  const frames = Array.from(document.querySelectorAll("div"));
  const frame = frames.find((el) => {
    const style = getComputedStyle(el);
    const text = el.textContent ?? "";
    return style.overflowY === "auto" &&
      el.scrollHeight > el.clientHeight &&
      text.includes("Desktop server connection") &&
      text.includes("CLI profile") &&
      text.includes("Bearer token");
  });
  if (!frame) return null;
  return {
    scrollTop: frame.scrollTop,
    scrollHeight: frame.scrollHeight,
    clientHeight: frame.clientHeight,
  };
})()`;

const assertDesktopSettingsScrolls = async (page: PackagedDesktopPage): Promise<void> => {
  await page.setViewport(900, 420);
  await page.waitForExpression(
    `${settingsScrollFrameExpression} !== null`,
    30_000,
    "the desktop settings scroll frame",
  );
  const before = await page.evaluate<{
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  }>(settingsScrollFrameExpression);
  expect(
    before.scrollHeight,
    "the settings page should have overflow content in a short desktop window",
  ).toBeGreaterThan(before.clientHeight);

  await page.wheel(450, 220, 640);
  await page.waitForExpression(
    `${settingsScrollFrameExpression}?.scrollTop > ${before.scrollTop}`,
    30_000,
    "desktop settings to scroll after a wheel gesture",
  );
  const after = await page.evaluate<{
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  }>(settingsScrollFrameExpression);
  expect(after.scrollTop, "wheel scrolling should move the settings page").toBeGreaterThan(
    before.scrollTop,
  );
};

const openDesktopSettings = async (page: PackagedDesktopPage): Promise<void> => {
  const clicked = await page.evaluate<boolean>(`(() => {
    const link = document.querySelector('a[href*="desktop-settings"]');
    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  })()`);
  expect(clicked, "the packaged desktop app should expose a Settings nav link").toBe(true);
  await page.waitForText("Desktop server connection", 30_000);
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
  expect(opened, "the packaged desktop app should expose the server profile trigger").toBe(true);
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
  const clicked =
    !open ||
    (await page.evaluate<boolean>(`(() => {
      const trigger = document.querySelector('[aria-label^="Select Executor server:"]');
      if (!(trigger instanceof HTMLButtonElement)) return false;
      trigger.click();
      return true;
    })()`));
  expect(clicked, "the server profile trigger should close its open popover").toBe(true);
  await page.waitForExpression(
    `document.querySelector('[data-slot="popover-content"][data-state="open"]') === null`,
    30_000,
    "the server profiles popover to close",
  );
};

const clickServerProfileButton = async (page: PackagedDesktopPage, text: string) => {
  const clicked = await page.evaluate<boolean>(`(() => {
    const content = document.querySelector('[data-slot="popover-content"][data-state="open"]');
    if (!(content instanceof HTMLElement)) return false;
    const expected = ${JSON.stringify(text)};
    const button = Array.from(content.querySelectorAll("button")).find(
      (candidate) => candidate.getClientRects().length > 0 &&
        candidate.textContent?.includes(expected),
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(clicked, `the server profiles popover should contain a ${text} button`).toBe(true);
};

const setServerProfileFormControl = async (
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
    const setter = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "value")?.set
      : undefined;
    if (!control || !setter) return false;
    setter.call(control, nextValue);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  expect(changed, `the server profile form should expose ${selector}`).toBe(true);
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
  await setServerProfileFormControl(
    page,
    'input[placeholder="https://executor.example"]',
    input.origin,
  );
  await setServerProfileFormControl(page, 'input[placeholder="Remote executor"]', input.name);
  await setServerProfileFormControl(page, "form select", "bearer");
  await page.waitForExpression(
    `document.querySelector('form input[type="password"]') !== null`,
    30_000,
    "the bearer token input",
  );
  await setServerProfileFormControl(page, 'form input[type="password"]', input.token);
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

const expectServerProfileKind = async (
  page: PackagedDesktopPage,
  name: string,
  kind: "Local" | "Remote",
) => {
  await openServerProfiles(page);
  await page.waitForExpression(
    `(() => {
      const content = document.querySelector('[data-slot="popover-content"][data-state="open"]');
      if (!(content instanceof HTMLElement)) return false;
      const button = Array.from(content.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes(${JSON.stringify(name)}),
      );
      return button?.parentElement?.textContent?.includes(${JSON.stringify(kind)}) ?? false;
    })()`,
    30_000,
    `the ${name} profile to be classified as ${kind}`,
  );
};

interface PersistedDesktopProfileProof {
  readonly kind: string;
  readonly key: string;
  readonly origin: string;
  readonly displayName: string;
  readonly token: string | null;
}

interface PersistedDesktopProfilesProof {
  readonly activeKey: string | null;
  readonly profiles: readonly PersistedDesktopProfileProof[];
}

const readPersistedDesktopProfiles = (page: PackagedDesktopPage) =>
  page.evaluate<PersistedDesktopProfilesProof>(`(() => {
    const bridge = window.executor;
    if (!bridge?.getServerProfiles) return { activeKey: null, profiles: [] };
    return bridge.getServerProfiles().then((raw) => {
      const snapshot = JSON.parse(raw ?? '{"profiles":[]}');
      return {
        activeKey: snapshot.activeKey ?? null,
        profiles: (snapshot.profiles ?? []).map((profile) => ({
          kind: profile.kind ?? "http",
          key: profile.key ?? "",
          origin: profile.origin ?? "",
          displayName: profile.displayName ?? "",
          token: profile.auth?.kind === "bearer" ? profile.auth.token : null,
        })),
      };
    });
  })()`);

const waitForPersistedDesktopProfiles = async (
  page: PackagedDesktopPage,
  displayNames: readonly string[],
  activeDisplayName?: string,
) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshot = await readPersistedDesktopProfiles(page);
    const active = snapshot.profiles.find((profile) => profile.key === snapshot.activeKey);
    if (
      displayNames.every((name) =>
        snapshot.profiles.some((profile) => profile.displayName === name),
      ) &&
      (activeDisplayName === undefined || active?.displayName === activeDisplayName)
    ) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for persisted desktop profiles: ${displayNames.join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const expectIntegrationAccount = async (
  page: PackagedDesktopPage,
  expected: string,
  rejected: string,
) => {
  await page.waitForText(expected, 30_000);
  expect(
    await page.textPresent(rejected),
    `the ${expected} account must not render data from ${rejected}`,
  ).toBe(false);
};

const writeStaleActiveServerProfile = (input: {
  readonly home: string;
  readonly port: number;
}): void => {
  const staleOrigin = `http://127.0.0.1:${input.port}`;
  const staleKey = `http:${staleOrigin}`;
  const settings = `${JSON.stringify(
    {
      server: { port: input.port },
      serverProfiles: JSON.stringify({
        version: 1,
        activeKey: staleKey,
        profiles: [
          {
            kind: "http",
            origin: staleOrigin,
            displayName: "Stale Basic daemon",
            auth: { kind: "basic", username: "executor", password: "wrong-password" },
          },
        ],
      }),
    },
    null,
    2,
  )}\n`;
  for (const settingsDir of new Set(desktopSettingsDirs(input.home))) {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), settings, { mode: 0o600 });
  }
};

scenario(
  "Desktop packaged supervised daemon · server manifest is owner-only",
  { timeout: 180_000 },
  Effect.promise(async () => {
    requirePackagedDesktopBundle();
    const home = createPackagedDesktopHome("executor-pkg-manifest-mode-");
    const dataDir = join(home, ".executor");
    const manifestPath = join(dataDir, "server-control", "server.json");
    const port = await freePort();
    let daemon: ChildProcess | undefined;
    const previousUmask = process.umask(0o022);
    try {
      const started = await startSupervisedDaemon({
        home,
        port,
        env: {
          EXECUTOR_SUPERVISED: "1",
          EXECUTOR_DATA_DIR: dataDir,
          EXECUTOR_AUTH_TOKEN: "manifest-mode-token",
          EXECUTOR_CLIENT: "desktop",
        },
      });
      daemon = started.child;
      expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(
        true,
      );
      await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 });

      const mode = statSync(manifestPath).mode & 0o777;
      expect(
        mode.toString(8).padStart(3, "0"),
        "server.json embeds the bearer and must be owner read/write only",
      ).toBe("600");
    } finally {
      process.umask(previousUmask);
      await stopProcess(daemon);
      removePackagedDesktopHome(home);
    }
  }),
);

const desktopPreflight = packagedDesktopPreflight();

if (desktopPreflight.status === "skip") {
  it.skip(`Desktop packaged supervised attach security (${desktopPreflight.reason})`, () => {});
} else if (desktopPreflight.status === "fail") {
  scenario(
    "Desktop packaged supervised attach security preflight",
    { timeout: 30_000 },
    Effect.die(desktopPreflight.reason),
  );
} else {
  scenario(
    "Desktop packaged supervised attach · a slow live daemon does not look crashed",
    { timeout: 240_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runSlowLiveDaemonProbe(runDir));
    }),
  );

  scenario(
    "Desktop packaged supervised attach · install failure falls back instead of black-screening",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runInstallFailureFallsBackToManagedSidecar(runDir));
    }),
  );

  scenario(
    "Desktop packaged supervised settings · changing the port moves the active daemon",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runSupervisedPortSetting(runDir));
    }),
  );

  scenario(
    "Desktop packaged supervised attach · integrations load through the CLI daemon with stale profiles",
    { timeout: 240_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runSupervisedIntegrationsLoad(runDir));
    }),
  );

  scenario(
    "Desktop packaged server profiles · same-origin accounts stay isolated across restart",
    { timeout: 360_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => runServerProfileSwitching(runDir));
    }),
  );
}

const writeCliDaemonManifest = (input: {
  readonly controlDir: string;
  readonly dataDir: string;
  readonly origin: string;
  readonly displayName: string;
  readonly token: string;
  readonly ownerVersion?: string | null;
  readonly ownerClient?: "cli" | "desktop";
  readonly ownerExecutablePath?: string | null;
}): void => {
  mkdirSync(input.controlDir, { recursive: true });
  writeFileSync(
    join(input.controlDir, "server.json"),
    serializeExecutorLocalServerManifest({
      version: 1,
      kind: "cli-daemon",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      dataDir: input.dataDir,
      scopeDir: input.dataDir,
      connection: normalizeExecutorServerConnection({
        origin: input.origin,
        displayName: input.displayName,
        auth: { kind: "bearer", token: input.token },
      }),
      owner: {
        client: input.ownerClient ?? "cli",
        version: input.ownerVersion ?? null,
        executablePath: input.ownerExecutablePath ?? null,
      },
    }),
    { mode: 0o600 },
  );
};

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const withFailingBundledInstall = async <T>(run: () => Promise<T>): Promise<T> => {
  const { executor } = requirePackagedDesktopBundle();
  const original = readFileSync(executor);
  const mode = statSync(executor).mode & 0o777;
  const backup = `${executor}.e2e-real`;
  writeFileSync(backup, original, { mode });
  chmodSync(backup, mode);
  writeFileSync(
    executor,
    [
      "#!/bin/sh",
      'if [ "$1" = "install" ]; then',
      '  echo "launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error" >&2',
      "  exit 1",
      "fi",
      `exec ${shellSingleQuote(backup)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    return await run();
  } finally {
    writeFileSync(executor, original, { mode });
    chmodSync(executor, mode);
    rmSync(backup, { force: true });
  }
};

const runInstallFailureFallsBackToManagedSidecar = async (runDir: string) => {
  const home = createPackagedDesktopHome("executor-pkg-install-failure-fallback-");
  const dataDir = join(home, ".executor");
  const controlDir = join(dataDir, "server-control");
  const token = "install-failure-fallback-token";
  const launchdSnapshot = captureLaunchdService();
  const oldPort = await freePort();
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  let resolveHealthProbe!: () => void;
  const sawHealthProbe = new Promise<void>((resolve) => {
    resolveHealthProbe = resolve;
  });
  let app: PackagedDesktopApp | undefined;
  let serverOpen = false;

  const server = createServer((req: IncomingMessage, res) => {
    const url = req.url ?? "/";
    requests.push({
      url,
      authorization: req.headers.authorization ?? null,
    });
    if (url.startsWith("/api/health")) {
      res.writeHead(200, {
        "content-type": "text/plain",
        connection: "close",
      });
      res.end("ok", () => {
        resolveHealthProbe();
        void closeServer();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Stale Executor</title><body>Stale daemon</body>");
  });
  const closeServer = async (): Promise<void> => {
    if (!serverOpen) return;
    serverOpen = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  try {
    await new Promise<void>((resolve) =>
      server.listen(oldPort, "127.0.0.1", () => {
        serverOpen = true;
        resolve();
      }),
    );
    writeCliDaemonManifest({
      controlDir,
      dataDir,
      origin: `http://127.0.0.1:${oldPort}`,
      displayName: "Older daemon that disappears",
      token,
      ownerVersion: "0.0.0",
    });

    await withFailingBundledInstall(async () => {
      const launched = await launchPackagedDesktop({ home });
      app = launched;
      const page = launched.cdp;
      await sawHealthProbe;
      await page.waitForText("Settings", 120_000);
      await launched.captureEvidence({
        rendererPath: join(runDir, "01-fell-back-to-managed-sidecar.png"),
      });

      const connection = await page.evaluate<{ readonly origin: string } | null>(
        "window.executor.getServerConnection()",
      );
      expect(
        new URL(connection!.origin).port,
        "desktop should not keep rendering from the stale daemon port after install failure",
      ).not.toBe(String(oldPort));
      expect(
        requests
          .filter((request) => request.url.startsWith("/api/health"))
          .map((request) => request.authorization),
        "the stale-daemon health probe must not disclose the saved bearer",
      ).not.toContain(`Bearer ${token}`);
    });
  } finally {
    await closePackagedDesktop(app);
    await restoreLaunchdService(launchdSnapshot);
    await closeServer();
    removePackagedDesktopHome(home);
  }
};

const runSlowLiveDaemonProbe = async (runDir: string) => {
  const home = createPackagedDesktopHome("executor-pkg-slow-live-daemon-");
  const dataDir = join(home, ".executor");
  const controlDir = join(dataDir, "server-control");
  const manifestPath = join(controlDir, "server.json");
  const token = "slow-live-daemon-token";
  const launchdSnapshot = captureLaunchdService();
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  let healthMode: "ok" | "slow" = "ok";
  let slowHealthResponses = 0;
  let resolveThirdSlowHealthResponse!: () => void;
  const thirdSlowHealthResponse = new Promise<void>((resolve) => {
    resolveThirdSlowHealthResponse = resolve;
  });
  const server = createServer((req: IncomingMessage, res) => {
    const url = req.url ?? "/";
    requests.push({
      url,
      authorization: req.headers.authorization ?? null,
    });
    if (url.startsWith("/api/health")) {
      if (healthMode === "slow") {
        setTimeout(() => {
          slowHealthResponses += 1;
          if (slowHealthResponses >= 3) resolveThirdSlowHealthResponse();
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        }, 5_000);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Executor</title><body><main>Fake Executor UI</main></body>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  let app: PackagedDesktopApp | undefined;

  try {
    writeCliDaemonManifest({
      controlDir,
      dataDir,
      origin: `http://127.0.0.1:${port}`,
      displayName: "Slow live daemon",
      token,
    });

    const launched = await launchPackagedDesktop({ home });
    app = launched;
    const page = launched.cdp;
    await page.waitForText("Fake Executor UI", 120_000);
    await launched.captureEvidence({
      rendererPath: join(runDir, "01-attached-to-fake-daemon.png"),
    });

    const firstHealthProbe = requests.find((request) => request.url.startsWith("/api/health"));
    expect(
      firstHealthProbe?.authorization ?? null,
      "the supervised-daemon health probe must not disclose the saved bearer",
    ).toBeNull();

    healthMode = "slow";
    const sawSlowMonitorProbe = await Promise.race([
      thirdSlowHealthResponse.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);
    expect(
      sawSlowMonitorProbe,
      "the packaged app should continue probing the supervised daemon after initial attach",
    ).toBe(true);

    expect(
      requests
        .filter((request) => request.url.startsWith("/api/health"))
        .map((request) => request.authorization),
      "supervised-daemon health probes must never carry the saved bearer",
    ).not.toContain(`Bearer ${token}`);
    expect(
      existsSync(manifestPath),
      "a live daemon's manifest must survive transient health probe failures",
    ).toBe(true);
    expect(
      await page.textPresent("The local Executor server stopped unexpectedly"),
      "one slow monitor probe should not show the crash screen",
    ).toBe(false);
    expect(
      await page.textPresent("Fake Executor UI"),
      "the original renderer should stay loaded",
    ).toBe(true);
    await launched.captureEvidence({
      rendererPath: join(runDir, "02-still-rendering-after-slow-health.png"),
    });
  } finally {
    await closePackagedDesktop(app);
    await restoreLaunchdService(launchdSnapshot);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removePackagedDesktopHome(home);
  }
};

const runSupervisedPortSetting = async (runDir: string) => {
  const home = createPackagedDesktopHome("executor-pkg-port-setting-");
  const dataDir = join(home, ".executor");
  const launchdSnapshot = captureLaunchdService();
  const oldPort = await freePort();
  const newPort = await freePort();
  let daemon: ChildProcess | undefined;
  let app: PackagedDesktopApp | undefined;

  try {
    const started = await startSupervisedDaemon({
      home,
      port: oldPort,
      env: {
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_AUTH_TOKEN: "port-setting-token",
        EXECUTOR_CLIENT: "desktop",
      },
    });
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${oldPort}/`, { timeoutMs: 30_000 });

    const launched = await launchPackagedDesktop({ home });
    app = launched;
    let page = launched.cdp;
    await page.waitForText("Settings", 120_000);
    await openDesktopSettings(page);
    await assertDesktopSettingsScrolls(page);
    await launched.captureEvidence({ rendererPath: join(runDir, "01-attached-settings.png") });

    const before = await page.evaluate<{ readonly origin: string } | null>(
      "window.executor.getServerConnection()",
    );
    expect(new URL(before!.origin).port, "test starts attached to the original port").toBe(
      String(oldPort),
    );

    await page.evaluate(`window.executor.updateSettings({ port: ${JSON.stringify(newPort)} })`);

    await page
      .evaluate("window.executor.restartServer().catch(() => undefined)")
      .catch(() => undefined);
    page = await reconnectPackagedDesktopPage(launched);
    await page.waitForText("Settings", 120_000);

    const after = await page.evaluate<{
      readonly settings: { readonly port: number };
      readonly connection: { readonly origin: string } | null;
    }>(
      "(async () => ({ settings: await window.executor.getSettings(), connection: await window.executor.getServerConnection() }))()",
    );

    expect(after.settings.port, "the setting was persisted").toBe(newPort);
    expect(
      new URL(after.connection!.origin).port,
      "after restart, the active supervised daemon should be serving on the saved port",
    ).toBe(String(newPort));
    await launched.captureEvidence({
      rendererPath: join(runDir, "02-restarted-on-new-port.png"),
    });
  } finally {
    await closePackagedDesktop(app);
    await stopProcess(daemon);
    await restoreLaunchdService(launchdSnapshot);
    removePackagedDesktopHome(home);
  }
};

const runSupervisedIntegrationsLoad = async (runDir: string) => {
  const home = createPackagedDesktopHome("executor-pkg-integrations-load-");
  const dataDir = join(home, ".executor");
  const launchdSnapshot = captureLaunchdService();
  const port = await freePort();
  let daemon: ChildProcess | undefined;
  let app: PackagedDesktopApp | undefined;

  try {
    writeStaleActiveServerProfile({ home, port });
    const started = await startSupervisedDaemon({
      home,
      port,
      hostname: "localhost",
      env: {
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_AUTH_TOKEN: "integrations-load-token",
        EXECUTOR_CLIENT: "desktop",
      },
    });
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://localhost:${port}/`, { timeoutMs: 30_000 });

    const rootDocument = await fetch(`http://localhost:${port}/`);
    expect(
      rootDocument.headers.get("cache-control"),
      "SPA boot document should not be cached",
    ).toBe("no-store");
    await rootDocument.body?.cancel();
    const indexDocument = await fetch(`http://localhost:${port}/index.html`);
    expect(
      indexDocument.headers.get("cache-control"),
      "direct index.html requests should not cache the SPA boot document",
    ).toBe("no-store");
    await indexDocument.body?.cancel();

    const launched = await launchPackagedDesktop({ home });
    app = launched;
    const page = launched.cdp;

    const serverLabel = await waitForServerConnectionLabel(page, "Local Executor", 120_000);
    expect(serverLabel, "desktop must not auto-select a stale persisted server profile").toContain(
      "Local Executor",
    );
    await page.waitForExpression(
      `document.querySelector('a[href$="/integrations/executor"]') !== null`,
      120_000,
      "the built-in Executor integration link",
    );
    const bootstrap = await page.evaluate<{
      readonly href: string;
      readonly navigationName: string;
    }>(
      `(() => {
        const navigation = performance.getEntriesByType("navigation")[0];
        return {
          href: location.href,
          navigationName: navigation?.name ?? "",
        };
      })()`,
    );
    expect(
      bootstrap.navigationName,
      "desktop should cache-bust each packaged renderer document load",
    ).toContain("_executor_desktop_launch=");
    expect(
      bootstrap.navigationName,
      "desktop should pass the daemon token during bootstrap",
    ).toContain("_token=");
    expect(
      bootstrap.href,
      "desktop should strip bootstrap cache-bust params after load",
    ).not.toContain("_executor_desktop_launch=");
    expect(bootstrap.href, "desktop should strip bootstrap token params after load").not.toContain(
      "_token=",
    );
    await launched.captureEvidence({
      rendererPath: join(runDir, "01-integrations-loaded.png"),
    });
    expect(
      await page.textPresent("Failed to load integrations").then((present) => (present ? 1 : 0)),
      "integrations should render from the attached daemon, not a cached 401/500 failure",
    ).toBe(0);

    const connection = await page.evaluate<{ readonly origin: string } | null>(
      "window.executor.getServerConnection()",
    );
    expect(
      new URL(connection!.origin).port,
      "the packaged app is rendering data from the supervised daemon",
    ).toBe(String(port));
  } finally {
    await closePackagedDesktop(app);
    await stopProcess(daemon);
    await restoreLaunchdService(launchdSnapshot);
    removePackagedDesktopHome(home);
  }
};

const runServerProfileSwitching = async (runDir: string) => {
  const home = createPackagedDesktopHome("executor-pkg-server-profiles-");
  const dataDir = join(home, ".executor");
  const launchdSnapshot = captureLaunchdService();
  const localPort = await freePort();
  const fixtureHost = nonLoopbackIpv4Address();
  if (!fixtureHost) {
    throw new Error("Packaged desktop account switching requires a non-loopback IPv4 interface");
  }
  const accountA = {
    name: "Remote account A",
    token: "desktop-profile-account-a",
    marker: "Wire catalog alpha",
    slug: "fixture-account-a",
  };
  const accountB = {
    name: "Remote account B",
    token: "desktop-profile-account-b",
    marker: "Wire catalog beta",
    slug: "fixture-account-b",
  };
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly authorization: string | null;
  }> = [];
  const integrationByAuthorization = new Map(
    [accountA, accountB].map((account) => [
      `Bearer ${account.token}`,
      {
        slug: account.slug,
        name: account.marker,
        description: `Bearer-specific catalog for ${account.name}`,
        kind: "fixture",
        canRemove: false,
        canRefresh: false,
        authMethods: [],
      },
    ]),
  );
  const fixture = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const authorization = req.headers.authorization ?? null;
    requests.push({ method, url, authorization });

    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ??
        "authorization, content-type, x-executor-org, traceparent, baggage",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin, Access-Control-Request-Headers");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(url, "http://desktop-profile-fixture").pathname;
    if (method !== "GET" || pathname !== "/api/integrations") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Not found" }));
      return;
    }

    const integration = authorization ? integrationByAuthorization.get(authorization) : undefined;
    if (!integration) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Invalid bearer" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([integration]));
  });
  let fixtureOpen = false;
  let daemon: ChildProcess | undefined;
  let app: PackagedDesktopApp | undefined;

  try {
    await new Promise<void>((resolve) => fixture.listen(0, fixtureHost, resolve));
    fixtureOpen = true;
    const fixturePort = (fixture.address() as net.AddressInfo).port;
    const fixtureOrigin = `http://${fixtureHost}:${fixturePort}`;

    const started = await startSupervisedDaemon({
      home,
      port: localPort,
      env: {
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_AUTH_TOKEN: "desktop-profile-local-token",
        EXECUTOR_CLIENT: "desktop",
      },
    });
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${localPort}/`, { timeoutMs: 30_000 });

    app = await launchPackagedDesktop({ home });
    let page = app.cdp;
    await waitForServerConnectionLabel(page, "Local Executor", 120_000);
    await page.waitForText("Integrations", 120_000);

    await addServerProfile(page, {
      origin: fixtureOrigin,
      name: accountA.name,
      token: accountA.token,
    });
    await expectIntegrationAccount(page, accountA.marker, accountB.marker);
    await expectServerProfileKind(page, accountA.name, "Remote");
    await closeServerProfiles(page);
    await app.captureEvidence({
      rendererPath: join(runDir, "01-account-a-catalog.png"),
    });

    await addServerProfile(page, {
      origin: fixtureOrigin,
      name: accountB.name,
      token: accountB.token,
    });
    await expectIntegrationAccount(page, accountB.marker, accountA.marker);
    await closeServerProfiles(page);
    await app.captureEvidence({
      rendererPath: join(runDir, "02-account-b-catalog.png"),
    });

    await selectServerProfile(page, accountA.name);
    await expectIntegrationAccount(page, accountA.marker, accountB.marker);
    await closeServerProfiles(page);
    await app.captureEvidence({
      rendererPath: join(runDir, "03-account-a-restored.png"),
    });

    await selectServerProfile(page, "Local Executor");
    await page.waitForExpression(
      `!document.body?.innerText.includes(${JSON.stringify(accountA.marker)}) &&
        !document.body?.innerText.includes(${JSON.stringify(accountB.marker)})`,
      30_000,
      "the local sidecar catalog to replace remote account data",
    );
    const localIntegrationsStatus = await page.evaluate<number>(`(() => {
      return window.executor.getServerConnection().then((connection) => {
        if (!connection) return 0;
        return fetch(new URL("/api/integrations", connection.origin)).then(
          (response) => response.status,
        );
      });
    })()`);
    expect(
      localIntegrationsStatus,
      "the preserved local sidecar profile should remain usable",
    ).toBe(200);
    await openServerProfiles(page);
    await page.waitForText(accountA.name, 30_000);
    await page.waitForText(accountB.name, 30_000);
    await app.captureEvidence({
      rendererPath: join(runDir, "04-local-sidecar-and-remote-profiles.png"),
    });
    await closeServerProfiles(page);

    await selectServerProfile(page, accountB.name);
    await expectIntegrationAccount(page, accountB.marker, accountA.marker);
    await closeServerProfiles(page);
    await app.captureEvidence({
      rendererPath: join(runDir, "05-account-b-before-restart.png"),
    });

    const beforeRestart = await waitForPersistedDesktopProfiles(
      page,
      [accountA.name, accountB.name],
      accountB.name,
    );
    const remoteBeforeRestart = beforeRestart.profiles.filter(
      (profile) => profile.displayName === accountA.name || profile.displayName === accountB.name,
    );
    expect(
      beforeRestart.profiles.some((profile) => profile.kind === "desktop-sidecar"),
      "the local sidecar profile should remain persisted while a remote account is active",
    ).toBe(true);
    expect(remoteBeforeRestart).toHaveLength(2);
    expect(remoteBeforeRestart.every((profile) => profile.origin === fixtureOrigin)).toBe(true);
    expect(new Set(remoteBeforeRestart.map((profile) => profile.key)).size).toBe(2);
    expect(remoteBeforeRestart.every((profile) => profile.key.startsWith("profile:"))).toBe(true);

    await closePackagedDesktop(app);
    app = undefined;
    await waitForHttp(`http://127.0.0.1:${localPort}/`, { timeoutMs: 30_000 });

    app = await launchPackagedDesktop({ home });
    page = app.cdp;
    await waitForServerConnectionLabel(page, accountB.name, 120_000);
    await expectIntegrationAccount(page, accountB.marker, accountA.marker);
    const afterRestart = await waitForPersistedDesktopProfiles(
      page,
      [accountA.name, accountB.name],
      accountB.name,
    );
    const remoteAfterRestart = afterRestart.profiles
      .filter(
        (profile) => profile.displayName === accountA.name || profile.displayName === accountB.name,
      )
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    expect(
      afterRestart.profiles.some((profile) => profile.kind === "desktop-sidecar"),
      "restoring the remote account must not remove the local sidecar profile",
    ).toBe(true);
    expect(remoteAfterRestart).toEqual([
      {
        kind: "http",
        key: remoteBeforeRestart.find((profile) => profile.displayName === accountA.name)!.key,
        origin: fixtureOrigin,
        displayName: accountA.name,
        token: accountA.token,
      },
      {
        kind: "http",
        key: remoteBeforeRestart.find((profile) => profile.displayName === accountB.name)!.key,
        origin: fixtureOrigin,
        displayName: accountB.name,
        token: accountB.token,
      },
    ]);
    await expectServerProfileKind(page, accountB.name, "Remote");
    await page.waitForText("Local Executor", 30_000);
    await app.captureEvidence({
      rendererPath: join(runDir, "06-account-b-restored-after-restart.png"),
    });
    await closeServerProfiles(page);

    await selectServerProfile(page, accountA.name);
    await expectIntegrationAccount(page, accountA.marker, accountB.marker);
    await closeServerProfiles(page);
    await app.captureEvidence({
      rendererPath: join(runDir, "07-account-a-after-restart.png"),
    });

    const integrationRequests = requests.filter(
      (request) =>
        request.method === "GET" &&
        new URL(request.url, "http://desktop-profile-fixture").pathname === "/api/integrations",
    );
    const authorizations = integrationRequests.map((request) => request.authorization);
    expect(authorizations).toContain(`Bearer ${accountA.token}`);
    expect(authorizations).toContain(`Bearer ${accountB.token}`);
    expect(
      authorizations.every(
        (authorization) =>
          authorization === `Bearer ${accountA.token}` ||
          authorization === `Bearer ${accountB.token}`,
      ),
      "the remote fixture must never receive the local sidecar bearer",
    ).toBe(true);
  } finally {
    await closePackagedDesktop(app);
    await stopProcess(daemon);
    await restoreLaunchdService(launchdSnapshot);
    if (fixtureOpen) {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
    removePackagedDesktopHome(home);
  }
};
