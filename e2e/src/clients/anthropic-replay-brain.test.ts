import { request } from "node:http";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { serveAnthropicReplayBrain } from "./anthropic-replay-brain";

const postJson = (url: string, body: unknown) =>
  Effect.callback<{ readonly status: number; readonly body: string }>((resume) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (piece: Buffer) => {
          responseBody += piece.toString("utf8");
        });
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              body: responseBody,
            }),
          ),
        );
      },
    );
    req.on("error", (cause) => resume(Effect.die(cause)));
    req.end(payload);
    return Effect.sync(() => req.destroy());
  });

it.effect("serves transcript-driven Anthropic tool use and tool-result continuation", () =>
  Effect.gen(function* () {
    const brain = yield* serveAnthropicReplayBrain((context) =>
      context.lastToolResult
        ? { text: `observed:${context.lastToolResult}` }
        : { tool: { name: "echo", input: { value: "hello" } } },
    );

    const first = yield* postJson(`${brain.baseUrl}/v1/messages?beta=true`, {
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [{ role: "user", content: "Use the echo tool." }],
      tools: [
        {
          name: "mcp__executor__echo",
          description: "Echo a value",
          input_schema: { type: "object" },
        },
      ],
    });
    expect(first.status).toBe(200);
    expect(first.body).toContain('"type":"tool_use"');
    expect(first.body).toContain('"name":"mcp__executor__echo"');
    expect(first.body).toContain('"stop_reason":"tool_use"');

    const second = yield* postJson(`${brain.baseUrl}/v1/messages?beta=true`, {
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [
        { role: "user", content: "Use the echo tool." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_replay_0",
              name: "mcp__executor__echo",
              input: { value: "hello" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_replay_0",
              content: [{ type: "text", text: "echoed:hello" }],
            },
          ],
        },
      ],
      tools: [{ name: "mcp__executor__echo", input_schema: { type: "object" } }],
    });
    expect(second.status).toBe(200);
    expect(second.body).toContain("observed:echoed:hello");
    expect(second.body).toContain('"stop_reason":"end_turn"');

    const requests = brain.requests();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.toolNames).toEqual(["mcp__executor__echo"]);
    expect(requests[1]?.messages.at(-1)?.toolResults).toEqual([
      { toolUseId: "toolu_replay_0", content: "echoed:hello", isError: false },
    ]);
    expect(brain.errors()).toEqual([]);
  }),
);
