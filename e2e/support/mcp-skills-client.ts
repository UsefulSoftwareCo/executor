/**
 * A host of the MCP Skills extension: the official TypeScript SDK's `SkillsClient`, which lists,
 * gets and reads a server's skills and checks every file's size, digest and frontmatter against the
 * entry it listed. Scenarios use it as a real client would, through Executor's `/mcp`.
 */
import { Client, ProtocolError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { Context, Effect, Layer, Redacted } from "effect";
import { randomBytes } from "node:crypto";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";
import { reveal } from "./failure-text.ts";

/** The revision a client speaks: the stateless 2026-07-28, or the sessionful 2025-11-25. */
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
        /** X-Executor-Organization, for a hosted credential that is not bound to one. */
        readonly organization?: string;
        /** A scoped connection's ID, for its own `/mcp?connection=` URL. */
        readonly connection?: string;
      },
    ) =>
      Effect.gen(function* () {
        const methods: string[] = [];
        // Record methods only; the credential stays out of the evidence.
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
          /** The JSON-RPC error code a request is refused with, or `undefined` when it succeeds. */
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

/** Case-scoped factory: each connected client has its own Effect lifetime. */
export class McpSkillsClient extends Context.Service<
  McpSkillsClient,
  Effect.Success<typeof make>
>()("e2e/McpSkillsClient") {
  static readonly layer = Layer.effect(McpSkillsClient, make);
}
