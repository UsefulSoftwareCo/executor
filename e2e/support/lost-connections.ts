/**
 * Requests to a stage go on connections of their own, and any lost before a response is recorded.
 *
 * Deployed runs on 16 November lost stage requests in bursts: reset before any response, never
 * reaching a Worker, while the stage kept answering. The recording that followed (#4688, #4695)
 * showed run #1082 lose 16, every one on a reused connection, 12 of them written 1-5 ms after that
 * connection's previous response, across 14 scenarios in three minutes: the far end closed
 * connections right after a response without saying so, and the next request crossed the close.
 * Its GETs were sent again and answered; its POSTs and DELETEs could not be, since they may have
 * been processed.
 *
 * So no request to a stage reuses a connection: each goes on its own, through a pool of Node's own
 * kind with keep-alive off (undici `pipelining: 0`), and the connection closes after its response,
 * streamed or not. A request then has nothing to cross, whatever its method, and nothing is ever
 * sent twice. HTTP/2 was not the alternative: undici 7.30.1, Node 24.22.1's bundled client, fails
 * the streams in flight on a `GOAWAY` without reading which ones the far end did not process.
 * Measured for #1082's 11,612 harness requests at 34-39 ms more per new TLS connection, this adds
 * about 25 s to a deployed run's 15.5-minute test phase over 16 workers; on the local lanes the
 * stage is a loopback server and the cost is a local connect.
 *
 * Requests to anything else (hosted emulators, registries, the browser's own) are unchanged.
 *
 * The recording stays: it is how a loss of another kind would show. It watches the diagnostics
 * channels undici publishes (`undici:client:connected` for a new connection,
 * `undici:client:sendHeaders` with the socket a request is written to, `undici:request:bodySent`,
 * `undici:request:trailers`) and the socket's own `data` event for a response's first byte, matched
 * to each stage request by an `x-executor-e2e-request` id header. A stage request that fails in
 * transport says whether its connection was new or reused, how many requests the connection had
 * carried and how old it was, how much of the request was written, and whether any byte of a
 * response arrived (`support/request-failure.ts`). With connections never reused, a loss records
 * "new connection": a different fault from the one above, such as a connection the far end refused
 * or reset.
 *
 * Every stage request lost in transport (before any response, or after one began) is kept with its
 * test file and scenario. The
 * scenario lifecycle saves a scenario's in the run's `report/lost-requests/`
 * (`e2e/lost-requests.ts`) and its evidence gets `lost-requests.json`; the setup file saves those
 * made outside any scenario (`beforeAll`, `afterAll`, a `layer`'s set-up and teardown) under the
 * file, and the suite's preparation saves its own. The job summary (`e2e/lost-request-summary.ts`)
 * counts them all, with the times.
 *
 * A request of which nothing was written to any connection is sent again, whatever its method: its
 * connect or TLS handshake failed, so no byte of it left the process. Connections are never reused,
 * so in a burst of new connections refused or reset (#1089 lost 9 requests that way, most "never
 * written to a connection" after 80-211 ms) every request needed a new one and failed with it. It
 * is sent again on a new connection at most 5 times, 1, 2, 4, 8 and 16 s after each failure (31 s
 * of waiting, ending inside a scenario's 60 s), and never at or past the scenario's own bound or
 * after its caller gave up. Only a failure of the connection itself counts (refused, reset, timed
 * out, a failed TLS handshake); one that would fail the same way again (an invalid argument, a
 * certificate that does not verify) is not repeated. A request whose headers were written, or whose
 * response had begun, is never sent again. Nor is one whose body may have been read (a stream).
 *
 * Why "nothing written" means no byte left the process, for undici 7.30.1 (Node 24.22.1):
 * - The connector hands undici a socket only on `secureConnect` (`connect` for plain HTTP). A
 *   refused connect or a failed handshake fails the request before undici's `writeH1` runs.
 * - In `writeH1`, `undici:client:sendHeaders` is published, synchronously, before the request's
 *   first write to the socket (`writeBuffer`, `writeStream`, `writeIterable`, `writeBlob`). Nothing
 *   before it writes to the socket. This module marks the request written in that publish.
 * - HTTP/2 is off: the pool sets no `allowH2`, so the connector offers only `http/1.1`.
 * - Each attempt carries its own `x-executor-e2e-request` id, and the publish carries the request
 *   it writes. A concurrent request's write can never mark this one, and an attempt never inherits
 *   an earlier attempt's state.
 * So a request that never got a connection, and one whose connection opened and failed before
 * undici wrote to it, both read `written: "nothing"`. A request undici began to write reads
 * "headers" or "whole request" even if the write then failed: the error lies only towards not
 * sending again.
 *
 * Each repeat is kept with the request (`repeats`: when each attempt failed, its code and time). A
 * request answered after repeats is recorded as "sent again: answered", and one that stays unsent
 * as "lost: never written" with why the repeats stopped. Both reach the scenario's evidence, the
 * job summary and, when the scenario fails anyway, its failure text.
 *
 * The test client only: the product's own clients are other processes and are unchanged.
 */
import { subscribe } from "node:diagnostics_channel";
import { randomBytes } from "node:crypto";

export const requestIdHeader = "x-executor-e2e-request";

/** What the client saw of one request's connection before it failed. */
export interface SentFacts {
  /** A new connection, or one an earlier request had used. Absent: the request was never written. */
  readonly connection?: "new" | "reused";
  /** How many requests the connection had carried before this one. */
  readonly earlierRequests?: number;
  /** How long ago the connection was opened. */
  readonly connectionAgeMs?: number;
  /** How long the reused connection had been idle since its last response completed. */
  readonly idleMs?: number;
  /** How much of the request was written: nothing, the headers, or the whole request. */
  readonly written: "nothing" | "headers" | "whole request";
  /** Whether any byte of a response arrived before the failure. */
  readonly responseStarted: boolean;
}

/**
 * Where a lost request was lost, or that it was answered after being sent again: only a request of
 * which nothing was written is ever sent again.
 */
export type LostOutcome =
  | "lost: new connection"
  | "lost: reused connection"
  | "lost: response had begun"
  | "lost: never written"
  | "sent again: answered";

/** One attempt of a request that failed with nothing written. */
export interface UnsentAttempt {
  readonly at: string;
  readonly code?: string;
  readonly elapsedMs: number;
}

/** Why a request that stayed unsent was not sent again. */
export type RepeatsStopped =
  | "5 repeats used"
  | "the scenario's bound"
  | "the caller gave up"
  | "its body cannot be sent twice"
  | "its failure is not a connection's";

/** The waits before each repeat of a request of which nothing was written. */
export const unsentRepeatDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** One stage request lost in transport, as the record and the evidence keep it. */
export interface LostRequest {
  readonly at: string;
  /** The scenario's title as Vitest names it; absent outside any scenario. */
  readonly scenario?: string;
  /** The test file, when a test file was running. */
  readonly file?: string;
  readonly method: string;
  /** The path only: a query can hold identifiers. */
  readonly path: string;
  readonly code?: string;
  /** From the first attempt to the last one's end, the repeats' waits included. */
  readonly elapsedMs: number;
  readonly sent: SentFacts;
  readonly outcome: LostOutcome;
  /** The failed attempts of a request sent again, oldest first; absent when it was not. */
  readonly repeats?: ReadonlyArray<UnsentAttempt>;
  /** Why a request of which nothing was written was not sent again. */
  readonly stopped?: RepeatsStopped;
}

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
  /** Stops watching the socket for this request's first response byte. */
  unwatch?: () => void;
}

const sockets = new WeakMap<object, SocketState>();
const socketOf = new WeakMap<object, object>();
const observed = new Map<string, Observed>();
const stageOrigins = new Set<string>();
const kept: Array<LostRequest> = [];
let currentScenario: () => string | undefined = () => undefined;
let currentFile: () => string | undefined = () => undefined;
/** When the running scenario's bound ends (epoch ms); no repeat starts at or past it. */
let currentDeadline: () => number | undefined = () => undefined;
/** Requests waiting to be sent again now, for a scenario that fails meanwhile. */
const waiting = new Set<{
  readonly scenario?: string;
  readonly since: number;
  readonly path: string;
}>();
/**
 * Set on `globalThis` once a copy of this module has wrapped `fetch`. A second copy of the module in
 * one process (a module graph loaded twice) must not wrap it again: its id header would replace the
 * first wrapper's, and the first would then read a written request as never written.
 */
const installedKey = Symbol.for("executor.e2e.lostConnections.installed");

/** The id header of an undici request, whose headers are a flat name, value array or a string. */
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
      // undici reads the socket on `readable`, so a `data` listener sees each read without
      // changing how undici reads.
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

/** Where a request with these facts was lost. */
export const lostOutcome = (facts: SentFacts): LostOutcome =>
  facts.responseStarted
    ? "lost: response had begun"
    : facts.connection === "reused"
      ? "lost: reused connection"
      : facts.connection === "new"
        ? "lost: new connection"
        : "lost: never written";

/** The facts a failed stage request carries on its error, for `request-failure.ts` to read. */
export const sentFactsKey = Symbol.for("executor.e2e.sentFacts");
/** What a lost request's error carries: its last attempt's facts, and its repeats when nothing was written. */
export type SentOnError = SentFacts & {
  readonly outcome?: LostOutcome;
  /** How many attempts failed with nothing written, the first included. */
  readonly repeats?: number;
  /** From the first attempt to the last one's end. */
  readonly waitedMs?: number;
  readonly stopped?: RepeatsStopped;
};
export const sentFacts = (error: unknown): SentOnError | undefined =>
  typeof error === "object" && error !== null && sentFactsKey in error
    ? (error as Record<symbol, SentOnError>)[sentFactsKey]
    : undefined;

/**
 * Node and undici codes, such as ECONNRESET. OpenSSL's are built from its reason text and can hold a
 * slash: a TLS alert in the handshake is `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`.
 */
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

/** A transport failure with no response, as opposed to an abort the caller asked for. */
const lostInTransport = (error: unknown) =>
  error instanceof TypeError &&
  !(error.cause instanceof DOMException) &&
  firstCode(error) !== undefined;

type Pool = { readonly close: () => Promise<void> };
let stagePool: Promise<Pool> | undefined;

/**
 * The stage's pool: Node's own dispatcher class with keep-alive off, so each request opens its own
 * connection and the connection closes after the response. Node creates its global dispatcher, and
 * so makes its class reachable, on its first `fetch`; a `data:` URL does that without a connection.
 */
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

/**
 * Whether a request's body can be given to `fetch` again unchanged: none, or one `fetch` reads
 * afresh each time (a string, bytes, a Blob, form fields). A stream, an async iterable or anything
 * else may have been read by the first attempt.
 */
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

/**
 * Failures of the connection itself: refused, reset, timed out, unreachable, closed, or a TLS
 * handshake that failed. Anything else that fails before a write (an invalid argument, a
 * certificate that does not verify) would fail again the same way, so it is not repeated.
 */
const connectionFailure =
  /^(?:ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_CLOSED|EPROTO|ERR_SSL_[\w/]+)$/u;

/** Waits, unless the caller gives up first: then false. */
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

/**
 * `fetch` that gives each stage request a connection of its own, records a lost one, and sends again
 * one of which nothing was written to any connection.
 */
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
    const record = (fields: Omit<LostRequest, "at" | "method" | "path" | "scenario" | "file">) =>
      kept.push({
        at: new Date().toISOString(),
        ...(scenario !== undefined && { scenario }),
        ...(file !== undefined && { file }),
        method,
        path: url.pathname,
        ...fields,
      });
    return poolFor(original).then((dispatcher) => {
      const started = Date.now();
      const repeats: Array<UnsentAttempt> = [];
      // Each attempt is its own request to undici, with its own id and record of what was written.
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
            // This attempt is over: its facts stay in `entry`, read below.
            entry.unwatch?.();
            observed.delete(id);
          })
          .then(
            (response) => {
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
              if (!lostInTransport(error)) throw error;
              const facts = factsOf(entry);
              const code = firstCode(error);
              const lost = (stopped?: RepeatsStopped) => {
                const outcome = lostOutcome(facts);
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
              // Undici wrote some of it, or a response began: it may have been processed.
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

/**
 * A failed scenario's note on its requests that never got a connection: those that stayed unsent,
 * and those still waiting to be sent again when it failed. Empty when there are none.
 */
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

/**
 * Start a scenario's stage origins afresh with the run's own, and say how a record names its
 * scenario and test file. Each target a scenario then starts adds its origins (`addStageOrigins`)
 * as soon as it exists, before any request is sent to it.
 */
export const configureLostConnections = (options: {
  readonly origins: Iterable<string>;
  readonly scenario?: () => string | undefined;
  readonly file?: () => string | undefined;
  /** When the running scenario's bound ends (epoch ms): no repeat starts at or past it. */
  readonly deadline?: () => number | undefined;
}) => {
  stageOrigins.clear();
  addStageOrigins(options.origins);
  if (options.scenario !== undefined) currentScenario = options.scenario;
  if (options.file !== undefined) currentFile = options.file;
  if (options.deadline !== undefined) currentDeadline = options.deadline;
};

/** Add origins a scenario's own target serves. */
export const addStageOrigins = (origins: Iterable<string>) => {
  for (const origin of origins) stageOrigins.add(new URL(origin).origin);
};

/** Watch the channels and wrap `globalThis.fetch`, once per process. */
export const installLostConnections = () => {
  const global = globalThis as Record<symbol, unknown>;
  if (global[installedKey] === true) return;
  global[installedKey] = true;
  watch();
  globalThis.fetch = lostConnectionFetch(globalThis.fetch);
};

/** The lost requests this process kept for one scenario, by its title, still unsaved. */
export const lostRequestsOf = (scenario: string) =>
  kept.filter((lost) => lost.scenario !== undefined && lost.scenario.endsWith(scenario));

/**
 * Remove and return the records a saver writes: one scenario's by its title, or, with no title,
 * those made outside any scenario. Each record is saved once.
 */
export const takeLostRequests = (scenario?: string) => {
  const taken = kept.filter((lost) =>
    scenario === undefined
      ? lost.scenario === undefined
      : lost.scenario !== undefined && lost.scenario.endsWith(scenario),
  );
  for (const lost of taken) kept.splice(kept.indexOf(lost), 1);
  return taken;
};

/** Remove and return every record still unsaved, for the saver at the end of a test file. */
export const takeAllLostRequests = () => kept.splice(0, kept.length);
