// Replay brain: a local server speaking the OpenAI chat-completions wire
// (SSE streaming, tool calls) that a REAL agent (OpenCode) uses as its LLM.
// The scenario scripts the brain; the agent does everything else for real —
// TUI rendering, MCP discovery/auth, tool execution against the target,
// result round-trips. "Replay brain, real hands": deterministic conversation,
// zero modeled client behavior.
//
// The brain is a state machine, not a fixed turn list: each request gets a
// normalized view of the conversation so far and the scenario's `respond`
// callback decides what the "model" says next (text, a tool call, or both).
// That lets a script absorb variable-length detours — approval pauses that
// need a resume call, retries — without index bookkeeping.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Scope } from "effect";

/** What the scenario's script sees per request. */
export interface BrainContext {
  /** 0-based count of requests served before this one. */
  readonly requestIndex: number;
  /** Role of the final message — "user" means a fresh human turn, "tool"
   *  means the agent is returning a tool result for the brain to continue. */
  readonly lastRole: string;
  /** The latest user-role message content (the human's chat input). */
  readonly lastUser: string;
  /** The latest tool-role message content (last tool result), if any. */
  readonly lastToolResult: string | undefined;
  /** Tool names offered in this request (already namespaced by the agent). */
  readonly toolNames: ReadonlyArray<string>;
}

/** What the "model" does next. `tool.name` may be a suffix — the brain
 *  resolves it against the request's offered tool names, so scripts don't
 *  hardcode the agent's MCP namespacing. */
export interface BrainResponse {
  readonly text?: string;
  readonly tool?: { readonly name: string; readonly args: unknown };
}

export interface ReplayBrain {
  /** Base URL for the agent's provider config (…/v1). */
  readonly baseUrl: string;
  /** Every request body served, in order (for post-hoc assertions). */
  readonly requests: () => ReadonlyArray<BrainRequest>;
  /** Script errors (mismatched expectations, throws) — assert empty. */
  readonly errors: () => ReadonlyArray<string>;
}

export interface BrainRequest {
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
  readonly toolNames: ReadonlyArray<string>;
}

interface WireMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: ReadonlyArray<unknown>;
}

interface WireBody {
  readonly messages?: ReadonlyArray<WireMessage>;
  readonly tools?: ReadonlyArray<{ function?: { name?: string } }>;
}

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
};

const sseChunk = (delta: Record<string, unknown>, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-replay",
    object: "chat.completion.chunk",
    created: 0,
    model: "replay-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/**
 * Serve a scripted brain for the lifetime of the surrounding scope.
 * `respond` is called once per chat-completions request.
 */
export const serveReplayBrain = (
  respond: (ctx: BrainContext) => BrainResponse,
): Effect.Effect<ReplayBrain, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ server: Server; brain: ReplayBrain }>((resume) => {
      const served: BrainRequest[] = [];
      const errors: string[] = [];

      const server = createServer((request, response) => {
        if (!request.url?.includes("/chat/completions")) {
          response.writeHead(404).end();
          return;
        }
        let raw = "";
        request.on("data", (piece: Buffer) => (raw += piece.toString("utf8")));
        request.on("end", () => {
          const body = JSON.parse(raw || "{}") as WireBody;
          const messages = (body.messages ?? []).map((message) => ({
            role: message.role,
            content: contentText(message.content),
          }));
          const toolNames = (body.tools ?? [])
            .map((tool) => tool.function?.name ?? "")
            .filter(Boolean);
          const requestIndex = served.length;
          served.push({ messages, toolNames });

          const lastOf = (role: string) =>
            [...messages].reverse().find((message) => message.role === role)?.content;

          let scripted: BrainResponse;
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a throwing script must surface as a recorded error + a stop response, not a hung agent
          try {
            scripted = respond({
              requestIndex,
              lastRole: messages.at(-1)?.role ?? "",
              lastUser: lastOf("user") ?? "",
              lastToolResult: lastOf("tool"),
              toolNames,
            });
          } catch (error) {
            errors.push(`respond() threw on request ${requestIndex}: ${String(error)}`);
            scripted = { text: "(replay brain script error)" };
          }

          // Resolve a scripted tool name against the agent's namespaced names.
          let resolvedTool: { name: string; args: unknown } | undefined;
          if (scripted.tool) {
            const wanted = scripted.tool.name;
            const match =
              toolNames.find((name) => name === wanted) ??
              toolNames.find((name) => name.endsWith(wanted));
            if (match) {
              resolvedTool = { name: match, args: scripted.tool.args };
            } else {
              errors.push(
                `request ${requestIndex}: no offered tool matches "${wanted}" (offered: ${toolNames.join(", ")})`,
              );
            }
          }

          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.write(sseChunk({ role: "assistant" }, null));
          if (scripted.text) {
            // A few chunks so the TUI streams like a real model reply.
            for (const piece of scripted.text.match(/.{1,24}/gs) ?? []) {
              response.write(sseChunk({ content: piece }, null));
            }
          }
          if (resolvedTool) {
            response.write(
              sseChunk(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${requestIndex}`,
                      type: "function",
                      function: {
                        name: resolvedTool.name,
                        arguments: JSON.stringify(resolvedTool.args ?? {}),
                      },
                    },
                  ],
                },
                null,
              ),
            );
          }
          response.write(sseChunk({}, resolvedTool ? "tool_calls" : "stop"));
          response.write("data: [DONE]\n\n");
          response.end();
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resume(
          Effect.succeed({
            server,
            brain: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              requests: () => served,
              errors: () => errors,
            },
          }),
        );
      });
    }),
    (resource: { server: Server; brain: ReplayBrain }) =>
      Effect.sync(() => void resource.server.close()),
  ).pipe(Effect.map(({ brain }) => brain));
