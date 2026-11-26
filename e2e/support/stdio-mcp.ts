import { Client as LatestClient, ProtocolError } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { StdioClientTransport as LatestStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Schema } from "effect";
import { failureText } from "./failure-text.ts";

export class StdioMcpFailed extends Schema.TaggedError<StdioMcpFailed>()("StdioMcpFailed", {
  message: Schema.String,
}) {}
const failed = (error: unknown) => new StdioMcpFailed({ message: failureText(error) });

export interface Elicitation {
  readonly message: string;
  readonly requestedSchema: unknown;
}

export const stdioMcp = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly elicit?: (request: Elicitation) => ElicitResult;
}) =>
  Effect.gen(function* () {
    const elicitations: Array<Elicitation> = [];
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          const client = new Client(
            { name: "executor-e2e-stdio", version: "1" },
            input.elicit === undefined ? {} : { capabilities: { elicitation: { form: {} } } },
          );
          const elicit = input.elicit;
          if (elicit !== undefined)
            client.setRequestHandler(ElicitRequestSchema, (request) => {
              const received = {
                message: request.params.message,
                requestedSchema:
                  "requestedSchema" in request.params ? request.params.requestedSchema : undefined,
              };
              elicitations.push(received);
              return elicit(received);
            });
          const transport = new StdioClientTransport({
            command: input.command,
            args: [...input.args],
            env: input.env,
            stderr: "ignore",
          });
          return client.connect(transport).then(() => client);
        },
        catch: failed,
      }),
      (client) => Effect.promise(() => client.close()),
    );
    return {
      instructions: client.getInstructions(),
      elicitations: elicitations as ReadonlyArray<Elicitation>,
      tools: Effect.tryPromise({
        try: () => client.listTools(),
        catch: failed,
      }).pipe(Effect.map(({ tools }) => tools.map((tool) => tool.name))),
      call: (name: string, input: Record<string, unknown>) =>
        Effect.tryPromise({
          try: () => client.callTool({ name, arguments: input }),
          catch: failed,
        }).pipe(Effect.map((result) => result.structuredContent)),
    };
  });

export const stdioMcpStateless = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          const client = new LatestClient(
            { name: "executor-e2e-stdio-stateless", version: "1" },
            { versionNegotiation: { mode: { pin: "2026-07-28" } } },
          );
          const transport = new LatestStdioClientTransport({
            command: input.command,
            args: [...input.args],
            env: input.env,
            stderr: "ignore",
          });
          return client.connect(transport).then(() => client);
        },
        catch: failed,
      }),
      (client) => Effect.promise(() => client.close()),
    );
    const skills = new SkillsClient(client);
    return {
      revision: client.getNegotiatedProtocolVersion(),
      instructions: client.getInstructions(),
      capabilities: client.getServerCapabilities(),
      use: <A>(action: (client: LatestClient, skills: SkillsClient) => Promise<A>) =>
        Effect.tryPromise({ try: () => action(client, skills), catch: failed }),
      refusal: (action: (client: LatestClient) => Promise<unknown>) =>
        Effect.tryPromise({
          try: () => action(client),
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap(() => Effect.fail(failed("The request succeeded"))),
          Effect.catch((cause) =>
            cause instanceof ProtocolError
              ? Effect.succeed(cause.code)
              : Effect.fail(failed(cause)),
          ),
        ),
    };
  });
