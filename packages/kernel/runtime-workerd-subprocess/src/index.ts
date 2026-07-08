/* oxlint-disable executor/no-try-catch-or-throw, executor/no-promise-reject, executor/no-instanceof-tagged-error -- subprocess boundary normalizes JavaScript errors into typed runtime errors */
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  recoverExecutionBody,
  stripTypeScript,
  type CodeExecutor,
  type ExecuteResult,
  type SandboxToolInvoker,
} from "@executor-js/codemode-core";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export const WORKERD_VERSION = "1.20260708.1";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_HOST_TIMEOUT_GRACE_MS = 30_000;
export class WorkerdSubprocessError extends Data.TaggedError("WorkerdSubprocessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type WorkerdToolBridge = {
  readonly call: (toolPath: string, args: unknown) => Promise<unknown>;
};

export type WorkerdModuleSource =
  | string
  | {
      readonly kind: "esModule";
      readonly source: string;
    }
  | {
      readonly kind: "wasm";
      readonly bytes: Uint8Array;
    };

export type WorkerdModuleRunnerOptions = {
  readonly modules: Readonly<Record<string, WorkerdModuleSource>>;
  readonly mainModule: string;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
  readonly toolBridge?: WorkerdToolBridge;
  readonly hostToken?: string;
  readonly unsafeEval?: boolean;
  readonly globalOutbound?: "blocked" | "internet";
  readonly workerdBin?: string;
  readonly startupTimeoutMs?: number;
  readonly restartBackoffMs?: number;
};

export type WorkerdRunResult<T = unknown> = {
  readonly status: number;
  readonly body: T;
  readonly elapsedMs: number;
};

export type WorkerdModuleRunner = {
  readonly pid: () => number | undefined;
  readonly ensureStarted: () => Promise<void>;
  readonly run: <T = unknown>(payload: unknown, timeoutMs?: number) => Promise<WorkerdRunResult<T>>;
  readonly dispose: () => Promise<void>;
  readonly crashForTest: () => void;
};

type PendingRequest = {
  readonly reject: (error: Error) => void;
};

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

const normalizeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const renderCause = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error) return squashed.message;
  return String(squashed);
};

const readRequestBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch (cause) {
        reject(cause);
      }
    });
  });

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const listenLocal = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
        return;
      }
      reject(new Error("server did not expose a TCP port"));
    });
  });

const reserveLocalPort = (): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> =>
  new Promise((resolve, reject) => {
    const server: NetServer = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve({
          port: address.port,
          close: () =>
            new Promise((closeResolve) => {
              server.close(() => closeResolve());
            }),
        });
        return;
      }
      reject(new Error("reservation did not expose a TCP port"));
    });
  });

const findWorkerdBin = async (configured?: string): Promise<string> => {
  if (configured) return configured;

  const candidates = [
    join(packageDir, "node_modules", "workerd", "bin", "workerd"),
    join(packageDir, "..", "..", "..", "node_modules", "workerd", "bin", "workerd"),
    join(process.cwd(), "node_modules", "workerd", "bin", "workerd"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next package-manager layout.
    }
  }

  return "workerd";
};

export const isWorkerdAvailable = (workerdBin?: string): boolean => {
  const configured = workerdBin ?? "workerd";
  const result = spawnSync(configured, ["--version"], {
    stdio: "ignore",
    timeout: 5000,
  });
  if (result.error === undefined && result.status === 0) return true;

  const local = spawnSync(
    join(packageDir, "node_modules", "workerd", "bin", "workerd"),
    ["--version"],
    {
      stdio: "ignore",
      timeout: 5000,
    },
  );
  if (local.error === undefined && local.status === 0) return true;

  const workspace = spawnSync(
    join(packageDir, "..", "..", "..", "node_modules", "workerd", "bin", "workerd"),
    ["--version"],
    {
      stdio: "ignore",
      timeout: 5000,
    },
  );
  return workspace.error === undefined && workspace.status === 0;
};

const capnpString = (value: string): string => JSON.stringify(value);

const buildConfig = (input: {
  readonly listenPort: number;
  readonly hostPort: number | null;
  readonly modules: Readonly<Record<string, WorkerdModuleSource>>;
  readonly mainModule: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly unsafeEval: boolean;
  readonly globalOutbound: "blocked" | "internet";
}): string => {
  const moduleNames = [
    input.mainModule,
    ...Object.keys(input.modules)
      .filter((name) => name !== input.mainModule)
      .sort(),
  ];
  const moduleEntries = moduleNames
    .map((name) => {
      const source = input.modules[name];
      const field = typeof source === "object" && source.kind === "wasm" ? "wasm" : "esModule";
      return `( name = ${capnpString(name)}, ${field} = embed ${capnpString(name)} )`;
    })
    .join(",\n    ");
  const services = [
    '( name = "main", worker = .mainWorker )',
    '( name = "blocked", worker = .blockedWorker )',
    ...(input.hostPort === null
      ? []
      : [`( name = "host", external = ( address = "127.0.0.1:${input.hostPort}", http = () ) )`]),
  ].join(",\n    ");
  const bindingEntries = [
    ...(input.hostPort === null ? [] : ['( name = "HOST", service = "host" )']),
    ...(input.unsafeEval ? ['( name = "UNSAFE_EVAL", unsafeEval = void )'] : []),
  ];
  const bindings =
    bindingEntries.length === 0 ? "" : `\n  bindings = [${bindingEntries.join(", ")}],`;
  const flags =
    input.compatibilityFlags.length === 0
      ? ""
      : `\n  compatibilityFlags = [${input.compatibilityFlags.map(capnpString).join(", ")}],`;

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ${services},
  ],
  sockets = [
    ( name = "http", address = "127.0.0.1:${input.listenPort}", http = (), service = "main" ),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    ${moduleEntries},
  ],
  compatibilityDate = ${capnpString(input.compatibilityDate)},${flags}${bindings}
  globalOutbound = ${capnpString(input.globalOutbound)},
);

const blockedWorker :Workerd.Worker = (
  serviceWorkerScript = "addEventListener('fetch', event => { event.respondWith(new Response('Outbound fetch is blocked.', { status: 403 })); })",
  compatibilityDate = ${capnpString(input.compatibilityDate)},
);
`;
};

const startToolServer = async (
  bridge: WorkerdToolBridge | undefined,
  token: string,
): Promise<{ readonly server: Server; readonly port: number }> => {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/tool") {
        writeJson(response, 404, { ok: false, error: "not found" });
        return;
      }
      if (request.headers["x-executor-token"] !== token) {
        writeJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (!bridge) {
        writeJson(response, 403, { ok: false, error: "tool bridge is not bound" });
        return;
      }
      try {
        const body = (await readRequestBody(request)) as { toolPath?: unknown; args?: unknown };
        if (typeof body.toolPath !== "string" || body.toolPath.length === 0) {
          writeJson(response, 400, { ok: false, error: "toolPath is required" });
          return;
        }
        const result = await bridge.call(body.toolPath, body.args);
        writeJson(response, 200, { ok: true, result });
      } catch (cause) {
        writeJson(response, 200, { ok: false, error: normalizeError(cause).message });
      }
    })();
  });
  const port = await listenLocal(server);
  return { server, port };
};

const waitReady = async (port: number, timeoutMs: number): Promise<void> => {
  const startedAt = performance.now();
  let lastError: unknown;
  while (performance.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__health`, { method: "POST" });
      if (response.ok) return;
      lastError = new Error(`health check returned ${response.status}`);
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`workerd did not become ready: ${normalizeError(lastError).message}`);
};

export const createWorkerdModuleRunner = (
  options: WorkerdModuleRunnerOptions,
): WorkerdModuleRunner => {
  const token = options.hostToken ?? crypto.randomUUID();
  const startupTimeoutMs = Math.max(100, options.startupTimeoutMs ?? 30_000);
  const restartBackoffMs = Math.max(0, options.restartBackoffMs ?? 100);
  const compatibilityDate = options.compatibilityDate ?? "2025-06-01";
  const compatibilityFlags = options.compatibilityFlags ?? ["nodejs_compat"];
  const pending = new Set<PendingRequest>();
  let processState:
    | {
        readonly proc: ChildProcessByStdio<null, Readable, Readable>;
        readonly tmp: string;
        readonly listenPort: number;
        readonly hostServer: Server;
      }
    | undefined;
  let starting: Promise<void> | undefined;
  let disposed = false;
  let lastExitAt = 0;

  const failPending = (message: string) => {
    const error = new Error(message);
    for (const request of pending) {
      request.reject(error);
    }
    pending.clear();
  };

  const disposeState = async (kill: boolean) => {
    const state = processState;
    processState = undefined;
    if (!state) return;
    if (kill && !state.proc.killed) {
      // workerd serve ignores SIGTERM in this version. SIGKILL is the verified immediate shutdown path.
      state.proc.kill("SIGKILL");
    }
    await closeServer(state.hostServer).catch(() => undefined);
    await rm(state.tmp, { recursive: true, force: true }).catch(() => undefined);
  };

  const start = async () => {
    if (disposed) throw new Error("workerd runner has been disposed");
    if (processState) return;
    if (starting) return starting;

    starting = (async () => {
      const now = Date.now();
      const delayMs = Math.max(0, restartBackoffMs - (now - lastExitAt));
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const tmp = join(
        tmpdir(),
        `executor-workerd-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
      );
      await mkdir(tmp, { recursive: true });
      for (const [name, source] of Object.entries(options.modules)) {
        if (typeof source === "string") {
          await writeFile(join(tmp, name), source);
        } else if (source.kind === "wasm") {
          await writeFile(join(tmp, name), source.bytes);
        } else {
          await writeFile(join(tmp, name), source.source);
        }
      }

      const hostServer = await startToolServer(options.toolBridge, token);
      const reservation = await reserveLocalPort();
      const listenPort = reservation.port;
      await writeFile(
        join(tmp, "config.capnp"),
        buildConfig({
          listenPort,
          hostPort: options.toolBridge ? hostServer.port : null,
          modules: options.modules,
          mainModule: options.mainModule,
          compatibilityDate,
          compatibilityFlags,
          unsafeEval: options.unsafeEval ?? false,
          globalOutbound: options.globalOutbound ?? "blocked",
        }),
      );
      await reservation.close();

      const workerdBin = await findWorkerdBin(options.workerdBin);
      const proc = spawn(workerdBin, ["serve", join(tmp, "config.capnp"), "--experimental"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stderr.setEncoding("utf8");
      proc.stdout.resume();
      proc.stderr.resume();
      proc.on("exit", (code, signal) => {
        lastExitAt = Date.now();
        if (processState?.proc === proc) {
          processState = undefined;
        }
        failPending(
          `workerd subprocess exited while requests were in flight (code=${String(code)} signal=${String(signal)})`,
        );
      });
      proc.on("error", (cause) => {
        failPending(`workerd subprocess error: ${normalizeError(cause).message}`);
      });
      processState = { proc, tmp, listenPort, hostServer: hostServer.server };
      try {
        await waitReady(listenPort, startupTimeoutMs);
      } catch (cause) {
        await disposeState(true);
        throw cause;
      }
    })();

    try {
      await starting;
    } finally {
      starting = undefined;
    }
  };

  const run = async <T = unknown>(
    payload: unknown,
    timeoutMs?: number,
  ): Promise<WorkerdRunResult<T>> => {
    await start();
    const state = processState;
    if (!state) throw new Error("workerd subprocess is not running");

    const controller = new AbortController();
    const effectiveTimeoutMs = Math.max(100, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(
      () => controller.abort(),
      effectiveTimeoutMs + DEFAULT_HOST_TIMEOUT_GRACE_MS,
    );
    const startedAt = performance.now();
    return await new Promise<WorkerdRunResult<T>>((resolve, reject) => {
      const pendingRequest = { reject };
      pending.add(pendingRequest);
      fetch(`http://127.0.0.1:${state.listenPort}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(async (response) => {
          const text = await response.text();
          const body = text.length > 0 ? (JSON.parse(text) as T) : (null as T);
          resolve({ status: response.status, body, elapsedMs: performance.now() - startedAt });
        })
        .catch((cause) => {
          reject(normalizeError(cause));
        })
        .finally(() => {
          clearTimeout(timer);
          pending.delete(pendingRequest);
        });
    });
  };

  return {
    pid: () => processState?.proc.pid,
    ensureStarted: start,
    run,
    dispose: async () => {
      disposed = true;
      failPending("workerd runner disposed while requests were in flight");
      await disposeState(true);
    },
    crashForTest: () => {
      const proc = processState?.proc;
      if (proc && !proc.killed) proc.kill("SIGKILL");
    },
  };
};

const codeDriverModule = (token: string, body: string, timeoutMs: number): string => `
const logs = [];
const fmt = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
const sandboxConsole = {
  log: (...args) => logs.push(args.map(fmt).join(" ")),
  info: (...args) => logs.push(args.map(fmt).join(" ")),
  warn: (...args) => logs.push("[warn] " + args.map(fmt).join(" ")),
  error: (...args) => logs.push("[error] " + args.map(fmt).join(" ")),
};
const callTool = async (env, path, args) => {
  const response = await env.HOST.fetch("http://host/tool", {
      method: "POST",
      headers: { "content-type": "application/json", "x-executor-token": ${JSON.stringify(token)} },
      body: JSON.stringify({ toolPath: path, args }),
    });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Internal tool error");
  return data.result;
};
const makeToolsProxy = (env, path = []) => new Proxy(() => undefined, {
  get(_target, prop) {
    if (prop === "then" || typeof prop === "symbol") return undefined;
    return makeToolsProxy(env, [...path, String(prop)]);
  },
  apply(_target, _thisArg, args) {
    const toolPath = path.join(".");
    if (!toolPath) throw new Error("Tool path missing in invocation");
    return callTool(env, toolPath, args[0]);
  },
});

export default {
  async fetch(request, env) {
    if (request.url.endsWith("/__health")) return Response.json({ ok: true });
    if (!request.url.endsWith("/run")) return new Response("Not Found", { status: 404 });
    logs.length = 0;
    try {
      const fn = env.UNSAFE_EVAL.eval(${JSON.stringify(`(async (tools, console) => { ${body} })`)});
      const result = await Promise.race([
        fn(makeToolsProxy(env), sandboxConsole),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out after ${timeoutMs}ms")), ${timeoutMs})),
      ]);
      return Response.json({ result, logs });
    } catch (error) {
      return Response.json({ error: { message: error.message || String(error) }, logs });
    }
  },
};
`;

const codeExecutorConfig = (
  body: string,
  timeoutMs: number,
  token: string,
): WorkerdModuleRunnerOptions => ({
  mainModule: "driver.js",
  modules: {
    "driver.js": codeDriverModule(token, body, timeoutMs),
  },
  toolBridge: { call: async () => undefined },
  unsafeEval: true,
});

const makeCodeToolBridge = (invoker: SandboxToolInvoker): WorkerdToolBridge => ({
  call: async (toolPath, args) =>
    Effect.runPromise(
      invoker
        .invoke({ path: toolPath, args })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.fail(new WorkerdSubprocessError({ message: renderCause(cause) })),
          ),
        ),
    ),
});

const executeWithWorkerd = (
  code: string,
  toolInvoker: SandboxToolInvoker,
  options: WorkerdCodeExecutorOptions,
): Effect.Effect<ExecuteResult, WorkerdSubprocessError> =>
  Effect.tryPromise({
    try: async () => {
      const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const body = stripTypeScript(recoverExecutionBody(code));
      const token = crypto.randomUUID();
      const runnerOptions = {
        ...codeExecutorConfig(body, timeoutMs, token),
        toolBridge: makeCodeToolBridge(toolInvoker),
        hostToken: token,
        ...(options.workerdBin === undefined ? {} : { workerdBin: options.workerdBin }),
      } satisfies WorkerdModuleRunnerOptions;
      const runner = createWorkerdModuleRunner(runnerOptions);
      try {
        const response = await runner.run<{
          result: unknown;
          output?: ExecuteResult["output"];
          error?: { readonly message?: string };
          logs?: string[];
        }>({}, timeoutMs);
        const error = response.body.error?.message;
        return {
          result: error ? null : response.body.result,
          ...(response.body.output ? { output: response.body.output } : {}),
          ...(error ? { error } : {}),
          ...(response.body.logs ? { logs: response.body.logs } : {}),
        };
      } finally {
        await runner.dispose();
      }
    },
    catch: (cause) =>
      new WorkerdSubprocessError({
        message: normalizeError(cause).message,
        cause,
      }),
  });

export type WorkerdCodeExecutorOptions = {
  readonly timeoutMs?: number;
  readonly workerdBin?: string;
};

export const makeWorkerdSubprocessExecutor = (
  options: WorkerdCodeExecutorOptions = {},
): CodeExecutor<WorkerdSubprocessError> => ({
  execute: (code, toolInvoker) => executeWithWorkerd(code, toolInvoker, options),
  timeoutMs: Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
});
