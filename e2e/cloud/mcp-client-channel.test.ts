import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;
const CLIENT_TOOL = "channel_echo";
const CLIENT_RESOURCE = "client://shared-item";
const CLIENT_PROMPT = "shared_prompt";

interface Registration {
  readonly token: string;
  readonly websocket: string;
}

interface ClientFrame {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Minimal masked RFC 6455 client used because Node's built-in WebSocket
 * cannot set the bearer and opaque binding headers required by this route. */
class HeaderWebSocket {
  private buffer = Buffer.alloc(0);
  private onFrame: ((frame: ClientFrame) => void) | undefined;

  private constructor(
    private readonly socket: Duplex,
    initial: Buffer,
  ) {
    socket.on("data", (chunk: Buffer) => this.consume(chunk));
    socket.on("close", () => undefined);
    socket.on("error", () => undefined);
    if (initial.length > 0) this.consume(initial);
  }

  static connect(url: string, bearer: string, token: string): Promise<HeaderWebSocket> {
    const target = new URL(url);
    return Effect.runPromise(
      Effect.callback<HeaderWebSocket, Error>((resume) => {
        const makeRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
        const request = makeRequest({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: {
            authorization: `Bearer ${bearer}`,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": randomBytes(16).toString("base64"),
            "x-executor-client-token": token,
          },
        });
        const timeout = setTimeout(
          () => request.destroy(new Error("WebSocket upgrade timed out")),
          15_000,
        );
        request.once("upgrade", (_response, socket, head) => {
          clearTimeout(timeout);
          resume(Effect.succeed(new HeaderWebSocket(socket, head)));
        });
        request.once("response", (response) => {
          clearTimeout(timeout);
          response.resume();
          resume(Effect.fail(new Error(`WebSocket upgrade rejected: ${response.statusCode}`)));
        });
        request.once("error", (error) => {
          clearTimeout(timeout);
          resume(Effect.fail(error));
        });
        request.end();
        return Effect.sync(() => request.destroy());
      }),
    );
  }

  onRequest(handler: (frame: ClientFrame) => void): void {
    this.onFrame = handler;
  }

  send(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value));
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index++) {
      masked[index] ^= mask[index % mask.length]!;
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close(): void {
    const mask = randomBytes(4);
    this.socket.write(Buffer.from([0x88, 0x80, ...mask]));
    this.socket.end();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.socket.destroy(new Error("WebSocket frame too large"));
          return;
        }
        length = Number(longLength);
        offset = 10;
      }
      const maskLength = second & 0x80 ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = maskLength ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] ^= mask[index % mask.length]!;
        }
      }
      const opcode = first & 0x0f;
      if (opcode === 0x8) {
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(Buffer.from([0x8a, payload.length, ...payload]));
        continue;
      }
      if (opcode !== 0x1) continue;
      const parsed: unknown = JSON.parse(payload.toString("utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "id" in parsed &&
        typeof parsed.id === "string" &&
        "method" in parsed &&
        typeof parsed.method === "string" &&
        "params" in parsed &&
        typeof parsed.params === "object" &&
        parsed.params !== null
      ) {
        this.onFrame?.(parsed as ClientFrame);
      }
    }
  }
}

const register = async (
  baseUrl: string,
  bearer: string,
  owner: "A" | "B",
): Promise<Registration> => {
  const response = await fetch(new URL("/mcp/client-channel", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      manifest: {
        tools: [
          {
            name: CLIENT_TOOL,
            description: `Client ${owner} tool`,
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
        resources: [{ uri: CLIENT_RESOURCE, name: `Client ${owner} resource` }],
        prompts: [
          {
            name: CLIENT_PROMPT,
            description: `Client ${owner} prompt`,
            arguments: [{ name: "topic", required: true }],
          },
        ],
      },
    }),
  });
  expect(response.status, "registration is accepted only through cloud bearer auth").toBe(201);
  return (await response.json()) as Registration;
};

const connectMcp = async (url: string, bearer: string, token: string) => {
  const client = new Client({ name: "client-channel-e2e", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-executor-client-token": token,
      },
    },
  });
  await client.connect(transport);
  return client;
};

scenario(
  "Cloud · client channel binds manifests and correlates calls to each owner",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const sessionUrl = target.mcpUrl;
    const [registrationA, registrationB] = yield* Effect.promise(() =>
      Promise.all([register(target.baseUrl, bearer, "A"), register(target.baseUrl, bearer, "B")]),
    );
    expect(registrationA.token).not.toBe(registrationB.token);
    expect(new URL(registrationA.websocket).search).toBe("");

    yield* Effect.promise(async () => {
      let channels: HeaderWebSocket[] = [];
      let clients: Client[] = [];
      try {
        channels.push(
          await HeaderWebSocket.connect(registrationA.websocket, bearer, registrationA.token),
        );
        channels.push(
          await HeaderWebSocket.connect(registrationB.websocket, bearer, registrationB.token),
        );
        const attachOwner = (socket: HeaderWebSocket, owner: "A" | "B") => {
          socket.onRequest((frame) => {
            const result =
              frame.method === "tools/call"
                ? { content: [{ type: "text", text: `owner-${owner}` }] }
                : frame.method === "resources/read"
                  ? { contents: [{ uri: CLIENT_RESOURCE, text: `owner-${owner}` }] }
                  : {
                      messages: [
                        {
                          role: "user",
                          content: { type: "text", text: `owner-${owner}` },
                        },
                      ],
                    };
            socket.send({ id: frame.id, result });
          });
        };
        attachOwner(channels[0]!, "A");
        attachOwner(channels[1]!, "B");
        clients.push(await connectMcp(sessionUrl, bearer, registrationA.token));
        clients.push(await connectMcp(sessionUrl, bearer, registrationB.token));
        const [clientA, clientB] = clients as [Client, Client];
        const toolsA = await clientA.listTools();
        const toolsB = await clientB.listTools();
        expect(toolsA.tools.find((tool) => tool.name === CLIENT_TOOL)?.description).toBe(
          "Client A tool",
        );
        expect(toolsB.tools.find((tool) => tool.name === CLIENT_TOOL)?.description).toBe(
          "Client B tool",
        );

        for (const [client, owner] of [
          [clientA, "A"],
          [clientB, "B"],
        ] as const) {
          const tool = await client.callTool({
            name: CLIENT_TOOL,
            arguments: { value: owner },
          });
          expect(
            ((tool.content as Array<{ text?: string }>)[0] as { text?: string }).text,
            `same-named tool invocation reaches client ${owner}`,
          ).toBe(`owner-${owner}`);
          const resource = await client.readResource({ uri: CLIENT_RESOURCE });
          expect(resource.contents[0]).toMatchObject({
            uri: CLIENT_RESOURCE,
            text: `owner-${owner}`,
          });
          const prompt = await client.getPrompt({
            name: CLIENT_PROMPT,
            arguments: { topic: owner },
          });
          expect(prompt.messages[0]?.content).toMatchObject({
            type: "text",
            text: `owner-${owner}`,
          });
        }
      } finally {
        channels.forEach((channel) => channel.close());
        await Promise.all(clients.map((client) => client.close()));
      }
    });
  }),
);
