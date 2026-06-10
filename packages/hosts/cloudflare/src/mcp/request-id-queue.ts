// The same-id JSON-RPC request queue used by the MCP worker transport.
// Pure logic with no Cloudflare/agents dependency, in its own module so it
// is unit-testable outside workerd.
import { Effect, Exit, Match, Option, Predicate } from "effect";

type JsonRpcLike = {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
};

type ToolCallParamsLike = {
  readonly name?: unknown;
  readonly arguments?: unknown;
};

type ResumeArgumentsLike = {
  readonly executionId?: unknown;
};

const jsonRpcRequestIdKey = (id: unknown): string | null =>
  Match.value(id).pipe(
    Match.whenOr(
      Match.string,
      Match.number,
      Match.boolean,
      (value) => `${typeof value}:${String(value)}`,
    ),
    Match.option,
    Option.getOrNull,
  );

const jsonRpcRequestQueueKey = (message: JsonRpcLike): string | null => {
  const idKey = jsonRpcRequestIdKey(message.id);
  if (!idKey) return null;

  if (message.method !== "tools/call") return idKey;
  if (!message.params || typeof message.params !== "object") return idKey;

  const params = message.params as ToolCallParamsLike;
  if (params.name !== "resume") return idKey;
  if (!params.arguments || typeof params.arguments !== "object") return idKey;

  const args = params.arguments as ResumeArgumentsLike;
  if (typeof args.executionId !== "string" || args.executionId.length === 0) return idKey;

  return `${idKey}:tools/call:resume:${args.executionId}`;
};

const extractJsonRpcRequestQueueKeys = async (request: Request): Promise<ReadonlyArray<string>> => {
  if (request.method !== "POST") return [];
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return [];

  const parsed = await Effect.runPromiseExit(Effect.tryPromise(() => request.clone().json()));
  if (Exit.isFailure(parsed)) {
    return [];
  }
  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const rpc = message as JsonRpcLike;
    if (typeof rpc.method !== "string") return [];
    const key = jsonRpcRequestQueueKey(rpc);
    return key ? [key] : [];
  });
};

// Hard ceiling on how long a same-id JSON-RPC request will wait for an
// earlier in-flight one to finish. Stays well under the 180s upstream
// client timeout that Claude / Cowork enforce, so a poisoned queue slot
// can't block the next request long enough for the client to give up.
// If a previous request hasn't released within the budget, we proceed
// anyway — at worst the MCP SDK rejects the second reply for a duplicate
// id, which is recoverable; a perma-stuck queue is not.
export const PREVIOUS_REQUEST_TIMEOUT_MS = 60_000;

export class JsonRpcRequestIdQueue {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly previousTimeoutMs: number;

  constructor(options: { readonly previousTimeoutMs?: number } = {}) {
    this.previousTimeoutMs = options.previousTimeoutMs ?? PREVIOUS_REQUEST_TIMEOUT_MS;
  }

  async run<A>(request: Request, run: () => Promise<A>): Promise<A> {
    const ids = [...new Set(await extractJsonRpcRequestQueueKeys(request))];
    if (ids.length === 0) return await run();

    const previous = ids.map((id) => this.inFlight.get(id)).filter(Predicate.isNotUndefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const id of ids) {
      this.inFlight.set(id, current);
    }

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: promise queue must release in-flight ids after callback completion
    try {
      if (previous.length > 0) {
        const settled = Promise.all(
          previous.map((p) => Effect.runPromise(Effect.ignore(Effect.tryPromise(() => p)))),
        );
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), this.previousTimeoutMs),
        );
        const outcome = await Promise.race([settled.then(() => "settled" as const), timeout]);
        if (outcome === "timeout") {
          console.warn(
            `[mcp-worker-transport] previous in-flight request for ids=${JSON.stringify(ids)} did not release within ${this.previousTimeoutMs}ms; proceeding anyway`,
          );
        }
      }
      return await run();
    } finally {
      for (const id of ids) {
        if (this.inFlight.get(id) === current) {
          this.inFlight.delete(id);
        }
      }
      release();
    }
  }
}
