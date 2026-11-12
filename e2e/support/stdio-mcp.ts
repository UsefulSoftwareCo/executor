/**
 * The official MCP client over stdio, starting a command as MCP clients such as Claude Code do.
 * The scope closes the client, which ends the command's standard input.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Schema } from "effect";

/** A failed MCP request; the SDK's message only, never a credential. */
export class StdioMcpFailed extends Schema.TaggedError<StdioMcpFailed>()("StdioMcpFailed", {
  message: Schema.String,
}) {}
const failed = (error: unknown) =>
  new StdioMcpFailed({ message: error instanceof Error ? error.message : String(error) });

/** A form the server asked the client to fill in, as the client received it. */
export interface Elicitation {
  readonly message: string;
  readonly requestedSchema: unknown;
}

/**
 * Start `command` with `env` only and connect to it, closed with the caller's scope. With `elicit`,
 * the client declares elicitation and answers each form request with what it returns; every request
 * it received is in `elicitations`.
 */
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
      /** The form requests the server sent, in order. */
      elicitations: elicitations as ReadonlyArray<Elicitation>,
      tools: Effect.tryPromise({
        try: () => client.listTools(),
        catch: failed,
      }).pipe(Effect.map(({ tools }) => tools.map((tool) => tool.name))),
      /** A tool's structured result. */
      call: (name: string, input: Record<string, unknown>) =>
        Effect.tryPromise({
          try: () => client.callTool({ name, arguments: input }),
          catch: failed,
        }).pipe(Effect.map((result) => result.structuredContent)),
    };
  });
