// Deterministic Anthropic Messages wire fixture for driving a REAL Claude Code
// binary without paid inference. Claude owns MCP discovery, tool selection,
// invocation, and result round-trips. This server only replaces the model
// boundary with a transcript-driven state machine.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Scope } from "effect";

export interface AnthropicToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface AnthropicReplayMessage {
  readonly role: string;
  readonly text: string;
  readonly toolResults: ReadonlyArray<AnthropicToolResult>;
}

export interface AnthropicReplayRequest {
  readonly path: string;
  readonly model: string;
  readonly messages: ReadonlyArray<AnthropicReplayMessage>;
  readonly toolNames: ReadonlyArray<string>;
  readonly stream: boolean;
}

export interface AnthropicReplayContext {
  readonly requestIndex: number;
  readonly messages: ReadonlyArray<AnthropicReplayMessage>;
  readonly lastRole: string;
  readonly lastUser: string;
  readonly lastToolResult: string | undefined;
  readonly toolResults: ReadonlyArray<AnthropicToolResult>;
  readonly toolNames: ReadonlyArray<string>;
}

export interface AnthropicReplayResponse {
  readonly text?: string;
  readonly tool?: {
    /** Exact offered tool name or a suffix such as `execute` or `echo`. */
    readonly name: string;
    readonly input: unknown;
  };
}

export interface AnthropicReplayBrain {
  /** Loopback origin assigned to ANTHROPIC_BASE_URL. */
  readonly baseUrl: string;
  readonly requests: () => ReadonlyArray<AnthropicReplayRequest>;
  readonly errors: () => ReadonlyArray<string>;
}

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isUnknownRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
};

const toolResultsFrom = (content: unknown): ReadonlyArray<AnthropicToolResult> => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isUnknownRecord(part) || part.type !== "tool_result") return [];
    return [
      {
        toolUseId: typeof part.tool_use_id === "string" ? part.tool_use_id : "",
        content: contentText(part.content),
        isError: part.is_error === true,
      },
    ];
  });
};

const messagesFrom = (body: Record<string, unknown>): ReadonlyArray<AnthropicReplayMessage> => {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.flatMap((message) => {
    if (!isUnknownRecord(message)) return [];
    return [
      {
        role: typeof message.role === "string" ? message.role : "",
        text: contentText(message.content),
        toolResults: toolResultsFrom(message.content),
      },
    ];
  });
};

const toolNamesFrom = (body: Record<string, unknown>): ReadonlyArray<string> => {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool) => {
    if (!isUnknownRecord(tool) || typeof tool.name !== "string") return [];
    return [tool.name];
  });
};

const writeJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const writeEvent = (response: ServerResponse, event: string, data: unknown) => {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
};

const resolveToolName = (wanted: string, offered: ReadonlyArray<string>) =>
  offered.find((name) => name === wanted) ??
  offered.find((name) => name.endsWith(`__${wanted}`)) ??
  offered.find((name) => name.endsWith(wanted));

const writeMessagesResponse = (
  response: ServerResponse,
  requestIndex: number,
  model: string,
  scripted: AnthropicReplayResponse,
  toolNames: ReadonlyArray<string>,
  errors: string[],
) => {
  const messageId = `msg_replay_${requestIndex}`;
  const resolvedToolName = scripted.tool
    ? resolveToolName(scripted.tool.name, toolNames)
    : undefined;
  if (scripted.tool && !resolvedToolName) {
    errors.push(
      `request ${requestIndex}: no offered tool matches "${scripted.tool.name}" (offered: ${toolNames.join(", ")})`,
    );
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });

  let blockIndex = 0;
  if (scripted.text) {
    writeEvent(response, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    });
    for (const piece of scripted.text.match(/.{1,32}/gs) ?? []) {
      writeEvent(response, "content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: piece },
      });
    }
    writeEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: blockIndex,
    });
    blockIndex += 1;
  }

  if (scripted.tool && resolvedToolName) {
    const toolUseId = `toolu_replay_${requestIndex}`;
    writeEvent(response, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: resolvedToolName,
        input: {},
      },
    });
    writeEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(scripted.tool.input ?? {}),
      },
    });
    writeEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: blockIndex,
    });
  }

  writeEvent(response, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: resolvedToolName ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 1 },
  });
  writeEvent(response, "message_stop", { type: "message_stop" });
  response.end();
};

/**
 * Serve an Anthropic Messages endpoint for the surrounding Effect scope.
 * The callback receives normalized conversation state on every model turn.
 */
export const serveAnthropicReplayBrain = (
  respond: (context: AnthropicReplayContext) => AnthropicReplayResponse,
): Effect.Effect<AnthropicReplayBrain, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: ReturnType<typeof createServer>;
      readonly brain: AnthropicReplayBrain;
    }>((resume) => {
      const served: AnthropicReplayRequest[] = [];
      const errors: string[] = [];
      const server = createServer((request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method !== "POST") {
          writeJson(response, 405, { error: { type: "method_not_allowed" } });
          return;
        }
        if (requestUrl.pathname === "/v1/messages/count_tokens") {
          writeJson(response, 200, { input_tokens: 1 });
          return;
        }
        if (requestUrl.pathname !== "/v1/messages") {
          errors.push(`unexpected request path: ${request.method} ${requestUrl.pathname}`);
          writeJson(response, 404, { error: { type: "not_found" } });
          return;
        }

        let raw = "";
        request.on("data", (piece: Buffer) => {
          raw += piece.toString("utf8");
        });
        request.on("end", () => {
          let decoded: unknown;
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: malformed wire JSON becomes a recorded fixture error and a 400 response
          try {
            decoded = JSON.parse(raw || "{}");
          } catch (cause) {
            errors.push(`request JSON decode failed: ${String(cause)}`);
            writeJson(response, 400, { error: { type: "invalid_request_error" } });
            return;
          }
          if (!isUnknownRecord(decoded)) {
            errors.push("request body was not a JSON object");
            writeJson(response, 400, { error: { type: "invalid_request_error" } });
            return;
          }

          const messages = messagesFrom(decoded);
          const toolNames = toolNamesFrom(decoded);
          const toolResults = messages.flatMap((message) => message.toolResults);
          const requestIndex = served.length;
          const model = typeof decoded.model === "string" ? decoded.model : "replay-model";
          served.push({
            path: `${requestUrl.pathname}${requestUrl.search}`,
            model,
            messages,
            toolNames,
            stream: decoded.stream === true,
          });

          const lastMessage = messages.at(-1);
          const lastHuman = [...messages]
            .reverse()
            .find(
              (message) =>
                message.role === "user" && message.toolResults.length === 0 && message.text !== "",
            );
          let scripted: AnthropicReplayResponse;
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a throwing transcript script is surfaced in fixture errors, never as a hung Claude process
          try {
            scripted = respond({
              requestIndex,
              messages,
              lastRole: lastMessage?.toolResults.length ? "tool" : (lastMessage?.role ?? ""),
              lastUser: lastHuman?.text ?? "",
              lastToolResult: toolResults.at(-1)?.content,
              toolResults,
              toolNames,
            });
          } catch (cause) {
            errors.push(`respond() threw on request ${requestIndex}: ${String(cause)}`);
            scripted = { text: "(anthropic replay script error)" };
          }
          writeMessagesResponse(response, requestIndex, model, scripted, toolNames, errors);
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resume(
          Effect.succeed({
            server,
            brain: {
              baseUrl: `http://127.0.0.1:${port}`,
              requests: () => served,
              errors: () => errors,
            },
          }),
        );
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(({ brain }) => brain));
