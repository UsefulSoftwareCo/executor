/**
 * Stage requests lost before any response, told apart and, where it is provably safe, sent again.
 *
 * Deployed runs on 16 November failed in bursts: a request reset 13-68 ms after it was sent, with
 * no response and no span on any Worker, while the stage kept answering every other request. That
 * is what a client sees when the far end has dropped a connection the client kept open and the
 * client then writes a request down it. A browser sends such a request again on a new connection;
 * Node's `fetch` fails it. Node's `fetch` does not say whether the connection was reused, so this
 * module watches the diagnostics channels Node's bundled HTTP client (undici 7.30.1 on Node
 * 24.22.1) publishes:
 *
 * - `undici:client:connected` names each new connection,
 * - `undici:client:sendHeaders` carries the socket a request is written to, just before its
 *   headers are written, so a socket seen before is a reused connection,
 * - `undici:request:bodySent` says the whole request was written,
 * - the socket's own `data` event, watched from `sendHeaders` on, says any byte of a response
 *   arrived, even one too short to be a status line,
 * - `undici:request:trailers` says a response completed, which starts the connection's idle time.
 *
 * Each request to a stage carries an `x-executor-e2e-request` header with a fresh id, which is how
 * an event is matched to the call that made it. A stage request that fails in transport carries
 * what was seen (`sentFacts`) to its failure text (`support/request-failure.ts`).
 *
 * The rule for sending again (`resendable`): once, on a new connection, only a GET or HEAD whose
 * reused connection was lost before any byte of a response arrived, and not one of the few GETs
 * that change state (`changesState`: sign-in and connection callbacks, OAuth authorization, an
 * unsubscribe link, or any GET carrying a `code`, `state` or `token`). Every other method is
 * never sent again, whatever was written: it may have been processed.
 *
 * Every stage request lost before any response is kept, sent again or not, with its test file and
 * scenario. The scenario lifecycle saves a scenario's in the run's `report/lost-requests/`
 * (`e2e/lost-requests.ts`) and its evidence gets `lost-requests.json`; the setup file saves those
 * made outside any scenario (`beforeAll`, `afterAll`, a `layer`'s set-up and teardown) under the
 * file, and the suite's preparation saves its own. The job summary
 * (`e2e/lost-request-summary.ts`) counts them all, with the times. A request sent again and lost
 * again fails with both attempts described; a scenario that fails after one of its requests was
 * sent again says so in its failure.
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
  /** How long the reused connection had been idle since its last response completed. */
  readonly idleMs?: number;
  /** How much of the request was written: nothing, the headers, or the whole request. */
  readonly written: "nothing" | "headers" | "whole request";
  /** Whether any byte of a response arrived before the failure. */
  readonly responseStarted: boolean;
}

/** Why a lost request was or was not sent again. */
export type LostOutcome =
  | "sent again: answered"
  | "sent again: failed"
  | "not sent again: new connection"
  | "not sent again: response had begun"
  | "not sent again: may have been processed"
  | "not sent again: GET may change state";

/** One stage request lost before any response, as the record and the evidence keep it. */
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
  /** The second attempt's code when it failed. */
  readonly againCode?: string;
  /** The status the second attempt was answered with. */
  readonly againStatus?: number;
}

interface SocketState {
  requests: number;
  lastCompletedAt?: number;
}
interface Observed {
  connection?: "new" | "reused";
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
    sockets.set((message as { socket: object }).socket, { requests: 0 });
  });
  subscribe("undici:client:sendHeaders", (message) => {
    const { request, socket } = message as { request: object; socket: object };
    const state = sockets.get(socket) ?? { requests: 0 };
    sockets.set(socket, state);
    socketOf.set(request, socket);
    const entry = entryOf(message);
    if (entry !== undefined) {
      entry.connection = state.requests > 0 ? "reused" : "new";
      if (state.requests > 0 && state.lastCompletedAt !== undefined)
        entry.idleMs = Date.now() - state.lastCompletedAt;
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
  ...(entry.idleMs !== undefined && { idleMs: entry.idleMs }),
  written: !entry.headersWritten ? "nothing" : entry.bodyWritten ? "whole request" : "headers",
  responseStarted: entry.responseStarted,
});

/** The facts a failed stage request carries on its error, for `request-failure.ts` to read. */
export const sentFactsKey = Symbol.for("executor.e2e.sentFacts");
export const sentFacts = (error: unknown): (SentFacts & { again?: LostRequest }) | undefined =>
  typeof error === "object" && error !== null && sentFactsKey in error
    ? (error as Record<symbol, SentFacts & { again?: LostRequest }>)[sentFactsKey]
    : undefined;

/**
 * The GETs that change state, which a resend could repeat: a sign-in or connection callback, an
 * OAuth authorization (it issues a code), an unsubscribe link, and any GET that carries a one-time
 * `code`, `state` or `token`. These are the stage GETs the harness sends from Node that do.
 */
export const changesState = (url: URL) =>
  /\/callback(?:\/|$)|\/oauth2\/authorize$|\/email\/unsubscribe$/u.test(url.pathname) ||
  ["code", "state", "token"].some((name) => url.searchParams.has(name));

/**
 * Whether a lost request may be sent again, and if not, why: only a GET or HEAD that does not
 * change state, lost on a reused connection before any byte of a response. undici marks a
 * connection reused in the same event that writes the request's headers, so a request on a reused
 * connection has always been written, and any other method may have been processed.
 */
export const resendable = (
  method: string,
  url: URL,
  facts: SentFacts,
): true | Exclude<LostOutcome, `sent again: ${string}`> => {
  if (facts.responseStarted) return "not sent again: response had begun";
  if (facts.connection !== "reused") return "not sent again: new connection";
  if (method !== "GET" && method !== "HEAD") return "not sent again: may have been processed";
  return changesState(url) ? "not sent again: GET may change state" : true;
};

const firstCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let level = 0; level < 6 && typeof current === "object" && current !== null; level++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/** A transport failure with no response, as opposed to an abort the caller asked for. */
const lostInTransport = (error: unknown) =>
  error instanceof TypeError &&
  !(error.cause instanceof DOMException) &&
  firstCode(error) !== undefined;

/** A dispatcher of the same kind as Node's own, with no connections yet: the second attempt's. */
const freshDispatcher = (): { close: () => Promise<void> } | undefined => {
  const global = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")];
  const Dispatcher = (global as { constructor?: new () => { close: () => Promise<void> } })
    ?.constructor;
  return typeof Dispatcher === "function" ? new Dispatcher() : undefined;
};

const tagged = (input: RequestInfo | URL, init: RequestInit | undefined, id: string) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(requestIdHeader, id);
  return { ...init, headers };
};

type Attempt =
  | { readonly response: Response }
  | { readonly error: unknown; readonly facts: SentFacts; readonly elapsedMs: number };

/** `fetch` with the facts and the rule above for requests to a stage origin; others pass through. */
export const lostConnectionFetch = (original: typeof fetch): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!stageOrigins.has(url.origin)) return original(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const attempt = (dispatcher?: object): Promise<Attempt> => {
      const id = randomBytes(8).toString("hex");
      const entry: Observed = { headersWritten: false, bodyWritten: false, responseStarted: false };
      observed.set(id, entry);
      const started = Date.now();
      return original(input, {
        ...tagged(input, init, id),
        ...(dispatcher !== undefined && { dispatcher }),
      } as RequestInit)
        .then(
          (response): Attempt => ({ response }),
          (error: unknown): Attempt => ({
            error,
            facts: factsOf(entry),
            elapsedMs: Date.now() - started,
          }),
        )
        .finally(() => {
          entry.unwatch?.();
          observed.delete(id);
        });
    };
    return attempt().then((first) => {
      if ("response" in first) return first.response;
      if (!lostInTransport(first.error)) throw first.error;
      const scenario = currentScenario();
      const file = currentFile();
      const code = firstCode(first.error);
      const base: Omit<LostRequest, "outcome" | "againCode"> = {
        at: new Date().toISOString(),
        ...(scenario !== undefined && { scenario }),
        ...(file !== undefined && { file }),
        method,
        path: url.pathname,
        ...(code !== undefined && { code }),
        elapsedMs: first.elapsedMs,
        sent: first.facts,
      };
      const decision = resendable(method, url, first.facts);
      const fail = (lost: LostRequest) => {
        kept.push(lost);
        // The failure the caller sees is the first one, carrying what happened after it.
        Object.defineProperty(first.error, sentFactsKey, {
          value: { ...first.facts, again: lost },
        });
        throw first.error;
      };
      if (decision !== true) return fail({ ...base, outcome: decision });
      const dispatcher = freshDispatcher();
      return attempt(dispatcher).then((second) => {
        void dispatcher?.close().catch(() => undefined);
        if ("response" in second) {
          kept.push({
            ...base,
            outcome: "sent again: answered",
            againStatus: second.response.status,
          });
          return second.response;
        }
        const againCode = firstCode(second.error);
        return fail({
          ...base,
          outcome: "sent again: failed",
          ...(againCode !== undefined && { againCode }),
        });
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
