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

/** Where a lost request was lost. Nothing is sent again. */
export type LostOutcome =
  | "lost: new connection"
  | "lost: reused connection"
  | "lost: response had begun"
  | "lost: never written";

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
  readonly elapsedMs: number;
  readonly sent: SentFacts;
  readonly outcome: LostOutcome;
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
let installed = false;

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
export const sentFacts = (error: unknown): (SentFacts & { outcome?: LostOutcome }) | undefined =>
  typeof error === "object" && error !== null && sentFactsKey in error
    ? (error as Record<symbol, SentFacts & { outcome?: LostOutcome }>)[sentFactsKey]
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

/** `fetch` that gives each stage request a connection of its own and records a lost one. */
export const lostConnectionFetch = (original: typeof fetch): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!stageOrigins.has(url.origin)) return original(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const id = randomBytes(8).toString("hex");
    const entry: Observed = { headersWritten: false, bodyWritten: false, responseStarted: false };
    return poolFor(original).then((dispatcher) => {
      observed.set(id, entry);
      const started = Date.now();
      return original(input, { ...tagged(input, init, id), dispatcher } as RequestInit)
        .catch((error: unknown) => {
          if (!lostInTransport(error)) throw error;
          const facts = factsOf(entry);
          const scenario = currentScenario();
          const file = currentFile();
          const code = firstCode(error);
          const outcome = lostOutcome(facts);
          kept.push({
            at: new Date().toISOString(),
            ...(scenario !== undefined && { scenario }),
            ...(file !== undefined && { file }),
            method,
            path: url.pathname,
            ...(code !== undefined && { code }),
            elapsedMs: Date.now() - started,
            sent: facts,
            outcome,
          });
          Object.defineProperty(error, sentFactsKey, { value: { ...facts, outcome } });
          throw error;
        })
        .finally(() => {
          entry.unwatch?.();
          observed.delete(id);
        });
    });
  }) as typeof fetch;

/**
 * Start a scenario's stage origins afresh with the run's own, and say how a record names its
 * scenario and test file. Each target a scenario then starts adds its origins (`addStageOrigins`)
 * as soon as it exists, before any request is sent to it.
 */
export const configureLostConnections = (options: {
  readonly origins: Iterable<string>;
  readonly scenario?: () => string | undefined;
  readonly file?: () => string | undefined;
}) => {
  stageOrigins.clear();
  addStageOrigins(options.origins);
  if (options.scenario !== undefined) currentScenario = options.scenario;
  if (options.file !== undefined) currentFile = options.file;
};

/** Add origins a scenario's own target serves. */
export const addStageOrigins = (origins: Iterable<string>) => {
  for (const origin of origins) stageOrigins.add(new URL(origin).origin);
};

/** Watch the channels and wrap `globalThis.fetch`, once per process. */
export const installLostConnections = () => {
  if (installed) return;
  installed = true;
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
