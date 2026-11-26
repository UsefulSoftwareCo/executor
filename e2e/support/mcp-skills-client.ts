import { Client, ProtocolError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { Context, Effect, Layer, Redacted } from "effect";
import { randomBytes } from "node:crypto";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";
import { reveal } from "./failure-text.ts";

export type SkillsRevision = "2026-07-28" | "2025-11-25";

const make = Effect.gen(function* () {
  const target = yield* Target,
    evidence = yield* Evidence;
  return {
    connect: (
      accessToken: Redacted.Redacted<string>,
      label: string,
      options: {
        readonly revision: SkillsRevision;
        readonly organization?: string;
        readonly connection?: string;
      },
    ) =>
      Effect.gen(function* () {
        const methods: string[] = [];
        const observedFetch: typeof fetch = (input, init) => {
          const request = new Request(input, init);
          request.headers.set("authorization", `Bearer ${reveal(accessToken)}`);
          if (options.organization !== undefined)
            request.headers.set("X-Executor-Organization", options.organization);
          const traceId = randomBytes(16).toString("hex"),
            spanId = randomBytes(8).toString("hex");
          request.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
          methods.push(request.headers.get("mcp-method") ?? request.method);
          return fetch(request);
        };
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Client(
                { name: "executor-e2e-skills", version: "1" },
                {
                  versionNegotiation: {
                    mode: options.revision === "2026-07-28" ? { pin: "2026-07-28" } : "legacy",
                  },
                },
              ),
          ),
          (client) => driver("close MCP skills client", () => client.close()).pipe(Effect.orDie),
        );
        const endpoint = new URL(`${target.metadata.origin}/mcp`);
        if (options.connection !== undefined)
          endpoint.searchParams.set("connection", options.connection);
        const transport = new StreamableHTTPClientTransport(endpoint, { fetch: observedFetch });
        yield* driver("connect the MCP skills client", () => client.connect(transport));
        yield* Effect.addFinalizer(() =>
          evidence.json(`mcp-skills-${label}.json`, {
            revision: client.getNegotiatedProtocolVersion(),
            capabilities: client.getServerCapabilities(),
            methods,
          }),
        );
        const skills = new SkillsClient(client);
        return {
          client,
          skills,
          revision: client.getNegotiatedProtocolVersion(),
          use: <A>(
            operation: string,
            action: (skills: SkillsClient, client: Client) => Promise<A>,
          ) =>
            evidence.step(
              operation,
              driver(operation, () => action(skills, client)),
            ),
          refusal: (
            operation: string,
            action: (skills: SkillsClient, client: Client) => Promise<unknown>,
          ) =>
            evidence.step(
              operation,
              Effect.tryPromise({
                try: () => action(skills, client).then(() => undefined),
                catch: (cause) => cause,
              }).pipe(
                Effect.catch((cause) =>
                  cause instanceof ProtocolError ? Effect.succeed(cause.code) : Effect.die(cause),
                ),
              ),
            ),
        };
      }),
  };
});

export class McpSkillsClient extends Context.Service<
  McpSkillsClient,
  Effect.Success<typeof make>
>()("e2e/McpSkillsClient") {
  static readonly layer = Layer.effect(McpSkillsClient, make);
}
