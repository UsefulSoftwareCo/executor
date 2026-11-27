import { subscribe } from "node:diagnostics_channel";
import { randomBytes } from "node:crypto";
import { shortPath } from "../lost-requests.ts";

export const requestIdHeader = "x-executor-e2e-request";

export interface SentFacts {
  readonly connection?: "new" | "reused";
  readonly earlierRequests?: number;
  readonly connectionAgeMs?: number;
  readonly idleMs?: number;
  readonly written: "nothing" | "headers" | "whole request";
  readonly responseStarted: boolean;
}

export type LostOutcome =
  | "lost: new connection"
  | "lost: reused connection"
  | "lost: response had begun"
  | "lost: never written"
  | "sent again: answered";

export interface UnsentAttempt {
  readonly at: string;
  readonly code?: string;
  readonly elapsedMs: number;
}

export type RepeatsStopped =
  | "5 repeats used"
  | "the scenario's bound"
  | "the caller gave up"
  | "its body cannot be sent twice"
  | "its failure is not a connection's";

export const unsentRepeatDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export interface LostRequest {
  readonly at: string;
  readonly scenario?: string;
  readonly file?: string;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly elapsedMs: number;
  readonly sent: SentFacts;
  readonly outcome: LostOutcome;
  readonly repeats?: ReadonlyArray<UnsentAttempt>;
  readonly stopped?: RepeatsStopped;
}

export interface StageRequest {
  readonly method: string;
  readonly path: string;
  readonly startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status?: number;
  failure?: string;
  traceId?: string;
  connection?: "new" | "reused";
  attempts?: number;
  outcome?: LostOutcome;
  stopped?: RepeatsStopped;
}

export const stageRequestLimit = 2000;

const stageRequests = new Map<string, { rows: Array<StageRequest>; dropped: number }>();

const startStageRequest = (scenario: string, row: StageRequest) => {
  let record = stageRequests.get(scenario);
  if (record === undefined) stageRequests.set(scenario, (record = { rows: [], dropped: 0 }));
  record.rows.push(row);
  if (record.rows.length > stageRequestLimit) {
    record.rows.shift();
    record.dropped += 1;
  }
};

const endStageRequest = (row: StageRequest | undefined, started: number) => {
  if (row === undefined) return;
  const now = Date.now();
  row.endedAt = new Date(now).toISOString();
  row.durationMs = now - started;
};

const traceIdOf = (input: RequestInfo | URL, init: RequestInit | undefined) => {
  const header =
    new Headers(init?.headers).get("traceparent") ??
    (input instanceof Request ? input.headers.get("traceparent") : null);
  const id = header?.split("-")[1];
  return id !== undefined && /^[0-9a-f]{32}$/u.test(id) ? id : undefined;
};

const failureOf = (error: unknown) =>
  firstCode(error) ??
  (error instanceof Error && error.name === "AbortError"
    ? "aborted"
    : error instanceof Error
      ? error.name
      : "other");

export const stageRequestsOf = (scenario: string) => {
  for (const [name, record] of stageRequests)
    if (name.endsWith(scenario))
      return { limit: stageRequestLimit, dropped: record.dropped, rows: [...record.rows] };
  return { limit: stageRequestLimit, dropped: 0, rows: [] as Array<StageRequest> };
};

export const forgetStageRequests = (scenario: string) => {
  for (const name of stageRequests.keys()) if (name.endsWith(scenario)) stageRequests.delete(name);
};

interface SocketState {
  readonly connectedAt: number;
  requests: number;
  lastCompletedAt?: number;
}
interface Observed {
  connection?: "new" | "reused";
  earlierRequests?: number;
  connectionAgeMs?: number;
  idleMs?: number;
  headersWritten: boolean;
  bodyWritten: boolean;
  responseStarted: boolean;
  unwatch?: () => void;
}

const sockets = new WeakMap<object, SocketState>();
const socketOf = new WeakMap<object, object>();
const observed = new Map<string, Observed>();
const stageOrigins = new Set<string>();
const kept: Array<LostRequest> = [];
let currentScenario: () => string | undefined = () => undefined;
let currentFile: () => string | undefined = () => undefined;
let currentDeadline: () => number | undefined = () => undefined;
const waiting = new Set<{
  readonly scenario?: string;
  readonly since: number;
  readonly path: string;
}>();
const installedKey = Symbol.for("executor.e2e.lostConnections.installed");

const idOf = (request: { headers?: unknown }): string | undefined => {
  const headers = request.headers;
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2)
      if (String(headers[index]).toLowerCase() === requestIdHeader)
        return String(headers[index + 1]);
    return undefined;
  }
  if (typeof headers === "string")
    return new RegExp(`^${requestIdHeader}:\\s*([0-9a-f]+)\\s*$`, "imu").exec(headers)?.[1];
  return undefined;
};

const entryOf = (message: unknown) => {
  const id = idOf((message as { request: { headers?: unknown } }).request);
  return id === undefined ? undefined : observed.get(id);
};

const watch = () => {
  subscribe("undici:client:connected", (message) => {
    sockets.set((message as { socket: object }).socket, { connectedAt: Date.now(), requests: 0 });
  });
  subscribe("undici:client:sendHeaders", (message) => {
    const { request, socket } = message as { request: object; socket: object };
    const state = sockets.get(socket) ?? { connectedAt: Date.now(), requests: 0 };
    sockets.set(socket, state);
    socketOf.set(request, socket);
    const entry = entryOf(message);
    if (entry !== undefined) {
      const now = Date.now();
      entry.connection = state.requests > 0 ? "reused" : "new";
      entry.earlierRequests = state.requests;
      entry.connectionAgeMs = now - state.connectedAt;
      if (state.requests > 0 && state.lastCompletedAt !== undefined)
        entry.idleMs = now - state.lastCompletedAt;
      entry.headersWritten = true;
      const stream = socket as NodeJS.ReadableStream;
      const onData = () => {
        entry.responseStarted = true;
      };
      stream.once("data", onData);
      entry.unwatch = () => stream.removeListener("data", onData);
    }
    state.requests += 1;
  });
  subscribe("undici:request:bodySent", (message) => {
    const entry = entryOf(message);
    if (entry !== undefined) entry.bodyWritten = true;
  });
  subscribe("undici:request:trailers", (message) => {
    const socket = socketOf.get((message as { request: object }).request);
    const state = socket === undefined ? undefined : sockets.get(socket);
    if (state !== undefined) state.lastCompletedAt = Date.now();
  });
};

const factsOf = (entry: Observed): SentFacts => ({
  ...(entry.connection !== undefined && { connection: entry.connection }),
  ...(entry.earlierRequests !== undefined && { earlierRequests: entry.earlierRequests }),
  ...(entry.connectionAgeMs !== undefined && { connectionAgeMs: entry.connectionAgeMs }),
  ...(entry.idleMs !== undefined && { idleMs: entry.idleMs }),
  written: !entry.headersWritten ? "nothing" : entry.bodyWritten ? "whole request" : "headers",
  responseStarted: entry.responseStarted,
});

export const lostOutcome = (facts: SentFacts): LostOutcome =>
  facts.responseStarted
    ? "lost: response had begun"
    : facts.connection === "reused"
      ? "lost: reused connection"
      : facts.connection === "new"
        ? "lost: new connection"
        : "lost: never written";

export const sentFactsKey = Symbol.for("executor.e2e.sentFacts");
export type SentOnError = SentFacts & {
  readonly outcome?: LostOutcome;
  readonly repeats?: number;
  readonly waitedMs?: number;
  readonly stopped?: RepeatsStopped;
};
export const sentFacts = (error: unknown): SentOnError | undefined =>
  typeof error === "object" && error !== null && sentFactsKey in error
    ? (error as Record<symbol, SentOnError>)[sentFactsKey]
    : undefined;

const codePattern = /^[A-Z][A-Z0-9_/]{1,63}$/u;

const firstCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let level = 0; level < 6 && typeof current === "object" && current !== null; level++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && codePattern.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

const lostInTransport = (error: unknown) =>
  error instanceof TypeError &&
  !(error.cause instanceof DOMException) &&
  firstCode(error) !== undefined;

type Pool = { readonly close: () => Promise<void> };
let stagePool: Promise<Pool> | undefined;

const poolFor = (original: typeof fetch): Promise<Pool> =>
  (stagePool ??= (
    (globalThis as Record<symbol, unknown>)[globalDispatcher] === undefined
      ? original("data:,").then((response) => response.arrayBuffer())
      : Promise.resolve()
  ).then(() => {
    const global = (globalThis as Record<symbol, unknown>)[globalDispatcher] as {
      constructor: new (options: { pipelining: number }) => Pool;
    };
    return new global.constructor({ pipelining: 0 });
  }));
const globalDispatcher = Symbol.for("undici.globalDispatcher.1");

const tagged = (input: RequestInfo | URL, init: RequestInit | undefined, id: string) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(requestIdHeader, id);
  return { ...init, headers };
};

const replayable = (input: RequestInfo | URL, init: RequestInit | undefined) => {
  if (input instanceof Request && input.body !== null && init?.body === undefined) return false;
  const body = init?.body;
  return (
    body === null ||
    body === undefined ||
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  );
};

const connectionFailure =
  /^(?:ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_CLOSED|EPROTO|ERR_SSL_[\w/]+)$/u;

const pause = (milliseconds: number, signal: AbortSignal | null | undefined) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted === true) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(true);
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });

export const lostConnectionFetch = (original: typeof fetch): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!stageOrigins.has(url.origin)) return original(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const scenario = currentScenario();
    const file = currentFile();
    const traceId = scenario === undefined ? undefined : traceIdOf(input, init);
    const row: StageRequest | undefined =
      scenario === undefined
        ? undefined
        : {
            method,
            path: shortPath(url.pathname),
            startedAt: new Date().toISOString(),
            ...(traceId !== undefined && { traceId }),
          };
    if (row !== undefined) startStageRequest(scenario!, row);
    const record = (fields: Omit<LostRequest, "at" | "method" | "path" | "scenario" | "file">) =>
      kept.push({
        at: new Date().toISOString(),
        ...(scenario !== undefined && { scenario }),
        ...(file !== undefined && { file }),
        method,
        path: url.pathname,
        ...fields,
      });
    const sent = Date.now();
    return poolFor(original).then((dispatcher) => {
      const started = Date.now();
      const repeats: Array<UnsentAttempt> = [];
      const attempt = (): Promise<Response> => {
        const id = randomBytes(8).toString("hex");
        const entry: Observed = {
          headersWritten: false,
          bodyWritten: false,
          responseStarted: false,
        };
        observed.set(id, entry);
        const attemptStarted = Date.now();
        return original(input, { ...tagged(input, init, id), dispatcher } as RequestInit)
          .finally(() => {
            entry.unwatch?.();
            observed.delete(id);
          })
          .then(
            (response) => {
              if (row !== undefined) {
                row.status = response.status;
                if (entry.connection !== undefined) row.connection = entry.connection;
                if (repeats.length > 0) row.attempts = repeats.length + 1;
                endStageRequest(row, sent);
              }
              if (repeats.length > 0)
                record({
                  ...(repeats[0]!.code !== undefined && { code: repeats[0]!.code }),
                  elapsedMs: Date.now() - started,
                  sent: { written: "nothing", responseStarted: false },
                  outcome: "sent again: answered",
                  repeats,
                });
              return response;
            },
            (error: unknown) => {
              if (!lostInTransport(error)) {
                if (row !== undefined && row.endedAt === undefined) {
                  row.failure = failureOf(error);
                  endStageRequest(row, sent);
                }
                throw error;
              }
              const facts = factsOf(entry);
              const code = firstCode(error);
              const lost = (stopped?: RepeatsStopped) => {
                const outcome = lostOutcome(facts);
                if (row !== undefined) {
                  row.failure = code ?? "other";
                  row.outcome = outcome;
                  if (facts.connection !== undefined) row.connection = facts.connection;
                  if (repeats.length > 1) row.attempts = repeats.length;
                  if (stopped !== undefined) row.stopped = stopped;
                  endStageRequest(row, sent);
                }
                record({
                  ...(code !== undefined && { code }),
                  elapsedMs: Date.now() - started,
                  sent: facts,
                  outcome,
                  ...(repeats.length > 0 && { repeats: [...repeats] }),
                  ...(stopped !== undefined && { stopped }),
                });
                Object.defineProperty(error, sentFactsKey, {
                  value: {
                    ...facts,
                    outcome,
                    repeats: repeats.length,
                    waitedMs: Date.now() - started,
                    ...(stopped !== undefined && { stopped }),
                  },
                });
                return error;
              };
              if (facts.written !== "nothing") throw lost();
              repeats.push({
                at: new Date().toISOString(),
                ...(code !== undefined && { code }),
                elapsedMs: Date.now() - attemptStarted,
              });
              if (code === undefined || !connectionFailure.test(code))
                throw lost("its failure is not a connection's");
              if (!replayable(input, init)) throw lost("its body cannot be sent twice");
              const delay = unsentRepeatDelaysMs[repeats.length - 1];
              if (delay === undefined) throw lost("5 repeats used");
              const deadline = currentDeadline();
              if (deadline !== undefined && Date.now() + delay >= deadline)
                throw lost("the scenario's bound");
              const wait = {
                ...(scenario !== undefined && { scenario }),
                since: started,
                path: url.pathname,
              };
              waiting.add(wait);
              return pause(delay, signal).then((waited) => {
                waiting.delete(wait);
                if (!waited) throw lost("the caller gave up");
                return attempt();
              });
            },
          );
      };
      return attempt();
    });
  }) as typeof fetch;

export const unsentNote = (scenario: string, now = Date.now()) => {
  const unsent = [
    ...kept
      .filter(
        (lost) =>
          lost.scenario?.endsWith(scenario) === true && lost.outcome === "lost: never written",
      )
      .map((lost) => lost.elapsedMs),
    ...[...waiting]
      .filter((wait) => wait.scenario?.endsWith(scenario) === true)
      .map((wait) => now - wait.since),
  ];
  if (unsent.length === 0) return "";
  const longest = (Math.max(...unsent) / 1000).toFixed(1);
  return unsent.length === 1
    ? `one stage request was unsent for ${longest} s: its connect or TLS handshake failed on every attempt (lost-requests.json)`
    : `${unsent.length} stage requests were unsent, the longest for ${longest} s: their connects or TLS handshakes failed on every attempt (lost-requests.json)`;
};

export const configureLostConnections = (options: {
  readonly origins: Iterable<string>;
  readonly scenario?: () => string | undefined;
  readonly file?: () => string | undefined;
  readonly deadline?: () => number | undefined;
}) => {
  stageOrigins.clear();
  addStageOrigins(options.origins);
  if (options.scenario !== undefined) currentScenario = options.scenario;
  if (options.file !== undefined) currentFile = options.file;
  if (options.deadline !== undefined) currentDeadline = options.deadline;
};

export const addStageOrigins = (origins: Iterable<string>) => {
  for (const origin of origins) stageOrigins.add(new URL(origin).origin);
};

export const installLostConnections = () => {
  const global = globalThis as Record<symbol, unknown>;
  if (global[installedKey] === true) return;
  global[installedKey] = true;
  watch();
  globalThis.fetch = lostConnectionFetch(globalThis.fetch);
};

export const lostRequestsOf = (scenario: string) =>
  kept.filter((lost) => lost.scenario !== undefined && lost.scenario.endsWith(scenario));

export const takeLostRequests = (scenario?: string) => {
  const taken = kept.filter((lost) =>
    scenario === undefined
      ? lost.scenario === undefined
      : lost.scenario !== undefined && lost.scenario.endsWith(scenario),
  );
  for (const lost of taken) kept.splice(kept.indexOf(lost), 1);
  return taken;
};

export const takeAllLostRequests = () => kept.splice(0, kept.length);
