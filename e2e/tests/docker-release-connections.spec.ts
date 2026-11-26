import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import { driver } from "../support/platform.ts";
import { releasedServer } from "../support/docker-release-server.ts";

interface Upload {
  readonly label: string;
  readonly padding: number;
  readonly pause: number;
}

const short: Upload = { label: "short body", padding: 0, pause: 0 };

const schedule: ReadonlyArray<Upload> = Array.from({ length: 10 }, () => [
  short,
  { label: "40 KiB body", padding: 40 * 1024, pause: 0 },
  { label: "body sent in two parts 300 ms apart", padding: 0, pause: 300 },
  short,
  { label: "body sent in two parts 1.2 s apart", padding: 0, pause: 1200 },
]).flat();

const answerWithin = 15_000;
const hung = `no answer within ${answerWithin} ms`;

const connections = new WeakMap<Socket, number>();
let nextConnection = 0;
const connectionOf = (socket: Socket) => {
  const known = connections.get(socket);
  if (known !== undefined) return known;
  nextConnection += 1;
  connections.set(socket, nextConnection);
  return nextConnection;
};

interface Sent {
  readonly outcome: string;
  readonly connection: number | undefined;
}

const post = (
  agent: Agent,
  port: number,
  path: string,
  headers: Record<string, string>,
  data: unknown,
  pause = 0,
) =>
  driver(
    `POST ${path}`,
    (signal) =>
      new Promise<Sent>((resolve) => {
        const body = JSON.stringify(data);
        let connection: number | undefined;
        const settle = (outcome: string) => {
          clearTimeout(deadline);
          resolve({ outcome, connection });
        };
        const deadline = setTimeout(() => settle(hung), answerWithin);
        const failed = (error: NodeJS.ErrnoException) => settle(error.code ?? error.message);
        const pending = request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            agent,
            signal,
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
              ...headers,
            },
          },
          (response) => {
            response.on("error", failed);
            response.resume();
            response.once("close", () =>
              settle(response.complete ? String(response.statusCode) : "answer cut short"),
            );
          },
        );
        pending.on("error", failed);
        pending.once("socket", (socket) => {
          connection = connectionOf(socket);
        });
        if (pause === 0) {
          pending.end(body);
          return;
        }
        const half = Math.floor(body.length / 2);
        pending.write(body.slice(0, half));
        setTimeout(() => {
          if (!pending.destroyed) pending.end(body.slice(half));
        }, pause);
      }),
  );

const reuse = (first: Sent, next: Sent) =>
  first.connection !== undefined && first.connection === next.connection
    ? "sent on the same connection"
    : "sent on another connection";

const client = Effect.acquireRelease(
  Effect.sync(() => new Agent({ keepAlive: true, maxSockets: 1 })),
  (agent) => Effect.sync(() => agent.destroy()),
);

it.live(
  "released image answers every client's POST on pooled connections after POSTs it refused without reading the body",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* releasedServer;
        const groups = `${server.prefix}/groups`;
        const group = (name: string, upload: Upload) => ({
          name,
          description: "x".repeat(upload.padding),
          memberIds: [],
        });
        const clients = 8;
        const members = Effect.forEach(
          Array.from({ length: clients }, (_, member) => member),
          (member) =>
            Effect.gen(function* () {
              const agent = yield* client;
              const outcomes: string[] = [];
              for (const [round, upload] of schedule.entries()) {
                const refused = yield* post(
                  agent,
                  server.port,
                  groups,
                  { origin: "http://elsewhere.example", cookie: server.session },
                  group(`Elsewhere ${member}-${round}`, upload),
                  upload.pause,
                );
                outcomes.push(`member from another origin, ${upload.label}: ${refused.outcome}`);
                if (refused.outcome === hung) break;
                const created = yield* post(
                  agent,
                  server.port,
                  groups,
                  { origin: server.origin, cookie: server.session },
                  group(`Group ${member}-${round}`, short),
                );
                outcomes.push(`member next on the connection: ${created.outcome}`);
                outcomes.push(`member next request ${reuse(refused, created)}`);
                if (created.outcome === hung) break;
              }
              return outcomes;
            }).pipe(Effect.scoped),
          { concurrency: "unbounded" },
        );
        const signedOut = Effect.forEach(
          Array.from({ length: clients }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const agent = yield* client;
              const outcomes: string[] = [];
              for (const [round, upload] of schedule.entries()) {
                const refused = yield* post(
                  agent,
                  server.port,
                  groups,
                  { origin: server.origin },
                  group(`Signed out ${index}-${round}`, upload),
                  upload.pause,
                );
                outcomes.push(`signed out, ${upload.label}: ${refused.outcome}`);
                if (refused.outcome === hung) break;
              }
              return outcomes;
            }).pipe(Effect.scoped),
          { concurrency: "unbounded" },
        );
        const created = yield* server.json(
          Schema.Struct({ key: Schema.String }),
          "/api/auth/api-key/create",
          { name: "Connections" },
        );
        const mcpHeaders = { accept: "application/json, text/event-stream" };
        const initialize = {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "connections", version: "1" },
          },
        };
        const mcpRounds = 25;
        const mcpClients = Effect.forEach(
          Array.from({ length: clients }, (_, index) => index),
          () =>
            Effect.gen(function* () {
              const agent = yield* client;
              const outcomes: string[] = [];
              for (let round = 0; round < mcpRounds; round++) {
                const refused = yield* post(agent, server.port, "/mcp", mcpHeaders, initialize);
                outcomes.push(`MCP initialize without a key: ${refused.outcome}`);
                if (refused.outcome === hung) break;
                const signed = yield* post(
                  agent,
                  server.port,
                  "/mcp",
                  {
                    ...mcpHeaders,
                    authorization: `Bearer ${created.key}`,
                    "x-executor-organization": server.organization,
                  },
                  initialize,
                );
                outcomes.push(
                  `MCP initialize with the key, next on the connection: ${signed.outcome}`,
                );
                outcomes.push(`MCP initialize with the key ${reuse(refused, signed)}`);
                if (signed.outcome === hung) break;
              }
              return outcomes;
            }).pipe(Effect.scoped),
          { concurrency: "unbounded" },
        );
        const [memberOutcomes, signedOutOutcomes, mcpOutcomes] = yield* Effect.all(
          [members, signedOut, mcpClients],
          { concurrency: "unbounded" },
        );
        const tally = (outcomes: ReadonlyArray<string>) => {
          const counts: Record<string, number> = {};
          for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
          return counts;
        };
        const sent = Array.from({ length: clients }, () => schedule).flat();
        const initialized = Array.from({ length: clients * mcpRounds });
        expect(tally([...memberOutcomes, ...signedOutOutcomes, ...mcpOutcomes].flat())).toEqual(
          tally([
            ...sent.map((upload) => `member from another origin, ${upload.label}: 403`),
            ...sent.map(() => "member next on the connection: 200"),
            ...sent.map(() => "member next request sent on the same connection"),
            ...sent.map((upload) => `signed out, ${upload.label}: 401`),
            ...initialized.map(() => "MCP initialize without a key: 401"),
            ...initialized.map(() => "MCP initialize with the key, next on the connection: 200"),
            ...initialized.map(() => "MCP initialize with the key sent on the same connection"),
          ]),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
