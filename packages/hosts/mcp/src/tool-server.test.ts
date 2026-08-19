import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect } from "effect";
import type * as Tracer from "effect/Tracer";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type ClientCapabilities } from "@modelcontextprotocol/server";
import type * as Cause from "effect/Cause";

import {
  ElicitationId,
  FormElicitation,
  ToolAddress,
  ToolResult,
  UrlElicitation,
} from "@executor-js/sdk";
import type { ToolFileValue } from "@executor-js/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

import {
  buildMcpServer,
  clientInfoFromRequestBody,
  formatMcpExecutionOutcome,
  type ExecutorMcpServerConfig,
  type McpClientInfo,
} from "./tool-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TestExecutionError extends Data.TaggedError("TestExecutionError")<{
  readonly message: string;
}> {}

const expectString: (value: unknown) => asserts value is string = (value) => {
  expect(typeof value).toBe("string");
};

const expectDefined: <T>(value: T) => asserts value is NonNullable<T> = (value) => {
  expect(value).toBeDefined();
};

const makeStubEngine = <E extends Cause.YieldableError = never>(overrides: {
  execute?: ExecutionEngine<E>["execute"];
  executeWithPause?: ExecutionEngine<E>["executeWithPause"];
  resume?: ExecutionEngine<E>["resume"];
  isExecutionSettled?: ExecutionEngine<E>["isExecutionSettled"];
  description?: string;
}): ExecutionEngine<E> => {
  const execute: ExecutionEngine<E>["execute"] =
    overrides.execute ?? (() => Effect.succeed({ result: "default" }));
  return {
    execute,
    executeWithPause:
      overrides.executeWithPause ??
      ((code) =>
        execute(code, {
          onElicitation: () => Effect.die("Unexpected elicitation in completed execution test"),
        }).pipe(Effect.map((result) => ({ status: "completed" as const, result })))),
    resume: overrides.resume ?? (() => Effect.succeed(null)),
    isExecutionSettled: overrides.isExecutionSettled,
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed(overrides.description ?? "test executor"),
  };
};

type TestServerConfig<E extends Cause.YieldableError> = Pick<
  ExecutorMcpServerConfig<E>,
  | "debug"
  | "elicitationMode"
  | "browserApprovalStore"
  | "pausedExecutionHooks"
  | "pausedExecutionLeaseMs"
  | "resumeFallback"
  | "onClientInfoChange"
>;

/** Connect a real MCP Client to our executor MCP server over in-memory transports. */
const withClient = async <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  capabilities: ClientCapabilities,
  fn: (client: Client) => Promise<void>,
  config?: TestServerConfig<E> & { readonly tracer?: Tracer.Tracer },
) => {
  const { tracer, ...serverConfig } = config ?? {};
  const create = buildMcpServer({
    engine,
    appsEnabled: false,
    requestStateSigningKey: new Uint8Array(32).fill(13),
    requestStatePrincipal: "tool-server-test-principal",
    sessionful: true,
    ...serverConfig,
  });
  const mcpServer = await Effect.runPromise(tracer ? Effect.withTracer(create, tracer) : create);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper must close MCP transports after async client assertions
  try {
    await fn(client);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

const withNativeClient = async <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  capabilities: ClientCapabilities,
  fn: (client: Client) => Promise<void>,
) => withClient(engine, capabilities, fn, { elicitationMode: { mode: "native" } });

type RecordedSpan = {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, unknown>;
  ended: boolean;
};

/** A tracer that records every span + its attributes and end state. */
const makeRecordingTracer = (): { tracer: Tracer.Tracer; spans: RecordedSpan[] } => {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const attributes = new Map<string, unknown>();
      const recorded: RecordedSpan = { name: options.name, attributes, ended: false };
      spans.push(recorded);
      let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
      return {
        _tag: "Span",
        name: options.name,
        spanId: `span-${spans.length}`,
        traceId: "trace-1",
        parent: options.parent,
        annotations: options.annotations,
        get status() {
          return status;
        },
        attributes,
        links: options.links,
        sampled: options.sampled,
        kind: options.kind,
        end: (endTime, exit) => {
          recorded.ended = true;
          status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
        },
        attribute: (key, value) => {
          attributes.set(key, value);
        },
        event: () => undefined,
        addLinks: () => undefined,
      };
    },
  };
  return { tracer, spans };
};

/** withClient, but with a recording tracer installed for the whole server. */
const withTracedClient = async <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  fn: (client: Client, spans: RecordedSpan[]) => Promise<void>,
  config?: TestServerConfig<E>,
) => {
  const { tracer, spans } = makeRecordingTracer();
  await withClient(engine, NO_CAPS, (client) => fn(client, spans), { ...config, tracer });
};

const ELICITATION_CAPS: ClientCapabilities = {
  elicitation: { form: {}, url: {} },
};
const NO_CAPS: ClientCapabilities = {};

/** Extract the first text content from a callTool result. */
const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0].text;

const STUB_TOOL_ADDRESS = ToolAddress.make("tools.test.org.main.t");
const TEST_IMAGE_MIME_TYPE = "image/png";
const TEST_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8N1wwAAAABJRU5ErkJggg==";

/** Build a stub paused ExecutionResult with the given id and elicitation request. */
const makePausedResult = (
  id: string,
  request: FormElicitation | UrlElicitation,
): ExecutionResult => ({
  status: "paused",
  execution: {
    id,
    elicitationContext: { address: STUB_TOOL_ADDRESS, args: {}, request },
  },
});

const toolFile = (input: {
  readonly name?: string;
  readonly mimeType: string;
  readonly data: string;
  readonly byteLength: number;
}): ToolFileValue => ({
  _tag: "ToolFile",
  ...(input.name ? { name: input.name } : {}),
  mimeType: input.mimeType,
  encoding: "base64",
  data: input.data,
  byteLength: input.byteLength,
});

// ---------------------------------------------------------------------------
// Explicit native elicitation mode
// ---------------------------------------------------------------------------

describe("MCP host server — native elicitation mode", () => {
  it("execute tool calls engine.executeWithPause and returns result", async () => {
    const engine = makeStubEngine({
      executeWithPause: (code) =>
        Effect.succeed({ status: "completed", result: { result: `ran: ${code}` } }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "1+1" },
      });
      expect(result.content).toEqual([{ type: "text", text: "ran: 1+1" }]);
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool renders emitted file image output as MCP images", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: { keptReturn: true },
          output: [
            {
              type: "file",
              file: toolFile({
                name: "photo.png",
                mimeType: "image/png",
                data: "iVBORw0KGgo=",
                byteLength: 8,
              }),
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "emit(attachment.data);" },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0]).toMatchObject({
        type: "text",
        text: "File output: photo.png (image/png, 8 bytes)",
      });
      expect(content[1]).toMatchObject({
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      });
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: { keptReturn: true },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool keeps the returned value in content when output was also emitted", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: { subject: "Flight receipt", total: 42 },
          output: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Flight receipt",
              },
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "emit(subject); return receipt;" },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0]).toMatchObject({ type: "text", text: "Flight receipt" });
      expect(content[1]).toMatchObject({
        type: "text",
        text: JSON.stringify({ subject: "Flight receipt", total: 42 }, null, 2),
      });
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: { subject: "Flight receipt", total: 42 },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool renders emitted MCP image content as MCP images", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: null,
          output: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Deterministic image fixture",
              },
            },
            {
              type: "content",
              content: {
                type: "image",
                data: TEST_IMAGE_PNG_BASE64,
                mimeType: TEST_IMAGE_MIME_TYPE,
              },
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: "emit(result.content[1]);",
        },
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: "Deterministic image fixture",
        },
        {
          type: "image",
          data: TEST_IMAGE_PNG_BASE64,
          mimeType: TEST_IMAGE_MIME_TYPE,
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: null,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool renders explicit upstream MCP content output unchanged", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: { forwarded: true },
          output: [
            {
              type: "content",
              content: {
                type: "text",
                text: "forwarded text",
              },
            },
            {
              type: "content",
              content: {
                type: "image",
                data: TEST_IMAGE_PNG_BASE64,
                mimeType: TEST_IMAGE_MIME_TYPE,
              },
            },
            {
              type: "content",
              content: {
                type: "audio",
                data: "SUQz",
                mimeType: "audio/mpeg",
              },
            },
            {
              type: "content",
              content: {
                type: "resource",
                resource: {
                  uri: "executor-file:///report.pdf",
                  mimeType: "application/pdf",
                  blob: "JVBERg==",
                },
              },
            },
            {
              type: "content",
              content: {
                type: "resource_link",
                uri: "executor-file:///remote.pdf",
                name: "remote.pdf",
                mimeType: "application/pdf",
              },
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: "for (const block of result.data.content) emit(block);",
        },
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: "forwarded text",
        },
        {
          type: "image",
          data: TEST_IMAGE_PNG_BASE64,
          mimeType: TEST_IMAGE_MIME_TYPE,
        },
        {
          type: "audio",
          data: "SUQz",
          mimeType: "audio/mpeg",
        },
        {
          type: "resource",
          resource: {
            uri: "executor-file:///report.pdf",
            mimeType: "application/pdf",
            blob: "JVBERg==",
          },
        },
        {
          type: "resource_link",
          uri: "executor-file:///remote.pdf",
          name: "remote.pdf",
          mimeType: "application/pdf",
        },
        {
          type: "text",
          text: JSON.stringify({ forwarded: true }, null, 2),
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: { forwarded: true },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool does not render returned ToolFile values as files", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: ToolResult.ok(
            toolFile({
              name: "photo.png",
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
              byteLength: 8,
            }),
          ),
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "return await tools.gmail.org.main.getAttachment({});" },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(String(content[0]?.text ?? "")).toContain('"_tag": "ToolFile"');
      expect(String(content[0]?.text ?? "")).toContain("iVBORw0KGgo=");
      expect(result.structuredContent).toMatchObject({
        status: "completed",
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool does not render returned upstream MCP image results as images", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: ToolResult.ok({
            content: [
              {
                type: "text",
                text: "Deterministic image fixture: mcp-image-fixture.png (image/png, 70 bytes)",
              },
              {
                type: "image",
                data: TEST_IMAGE_PNG_BASE64,
                mimeType: TEST_IMAGE_MIME_TYPE,
              },
            ],
            structuredContent: {
              name: "mcp-image-fixture.png",
              mimeType: TEST_IMAGE_MIME_TYPE,
              byteLength: 70,
            },
          }),
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: "return await tools.image_mcp.org.main.image_fixture_with_metadata({});",
        },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(String(content[0]?.text ?? "")).toContain('"type": "image"');
      expect(String(content[0]?.text ?? "")).toContain(TEST_IMAGE_PNG_BASE64);
      expect(result.structuredContent).toMatchObject({
        status: "completed",
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool renders mixed emitted text and file output in order", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: { subject: "Flight receipt" },
          output: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Flight receipt",
              },
            },
            {
              type: "file",
              file: toolFile({
                name: "boarding-pass.png",
                mimeType: "image/png",
                data: "iVBORw0KGgo=",
                byteLength: 8,
              }),
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "emit(subject); emit(attachment.data);" },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0]).toMatchObject({ type: "text", text: "Flight receipt" });
      expect(content[1]).toMatchObject({
        type: "text",
        text: "File output: boarding-pass.png (image/png, 8 bytes)",
      });
      expect(content[2]).toMatchObject({
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      });
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: { subject: "Flight receipt" },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool renders text-like emitted file output as MCP text", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: null,
          output: [
            {
              type: "file",
              file: toolFile({
                name: "rows.csv",
                mimeType: "text/csv",
                data: "YSxiCjEsMgo=",
                byteLength: 8,
              }),
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "emit(csv.data);" },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0]).toMatchObject({
        type: "text",
        text: "File output: rows.csv (text/csv, 8 bytes)",
      });
      expect(content[1]).toMatchObject({
        type: "text",
        text: "a,b\n1,2\n",
      });
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: null,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool renders emitted audio file output as MCP audio", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: null,
          output: [
            {
              type: "file",
              file: toolFile({
                name: "clip.mp3",
                mimeType: "audio/mpeg",
                data: "SUQzBAAAAAAA",
                byteLength: 9,
              }),
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "emit(audio.data);" },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0]).toMatchObject({
        type: "text",
        text: "File output: clip.mp3 (audio/mpeg, 9 bytes)",
      });
      expect(content[1]).toMatchObject({
        type: "audio",
        data: "SUQzBAAAAAAA",
        mimeType: "audio/mpeg",
      });
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: null,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool renders opaque binary emitted file output as embedded MCP resources", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: null,
          output: [
            {
              type: "file",
              file: toolFile({
                name: "report.pdf",
                mimeType: "application/pdf",
                data: "JVBERg==",
                byteLength: 4,
              }),
            },
          ],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "emit(attachment.data);" },
      });

      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0]).toMatchObject({
        type: "text",
        text: "File output: report.pdf (application/pdf, 4 bytes)",
      });
      expect(content[1]).toMatchObject({
        type: "resource",
        resource: {
          uri: "executor-file:///report.pdf",
          mimeType: "application/pdf",
          blob: "JVBERg==",
        },
      });
      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: null,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool surfaces failed engine effects as an opaque generic with correlation id", async () => {
    const engine = makeStubEngine({
      execute: () => Effect.fail(new TestExecutionError({ message: "Unexpected token ':'" })),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "const x: any = 1;" },
      });
      const text = textOf(result);
      expect(text).toMatch(/^Error: Internal tool error \[[0-9a-f]{8}\]$/);
      expect(text).not.toContain("Unexpected token");
      const structured = (result.structuredContent as { readonly error?: string }).error ?? "";
      expect(structured).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      expect(result.isError).toBe(true);
    });
  });

  it("execute tool hides defect details in MCP error results", async () => {
    const engine = makeStubEngine({
      // oxlint-disable-next-line executor/no-effect-escape-hatch, executor/no-error-constructor -- boundary: test injects a defect to verify MCP error redaction
      execute: () => Effect.die(new Error("secret internal detail")),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "run" },
      });
      const text = textOf(result);
      expect(text).toMatch(/^Error: Internal tool error \[[0-9a-f]{8}\]$/);
      // Sensitive internal context must NOT leak through the MCP error path.
      expect(text).not.toContain("secret internal detail");
      expect(result.structuredContent).toMatchObject({
        status: "error",
      });
      const structuredError = (result.structuredContent as { readonly error?: string }).error ?? "";
      expect(structuredError).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      expect(structuredError).not.toContain("secret internal detail");
      expect(result.isError).toBe(true);
    });
  });

  it("browser approval mode does not auto-switch to native elicitation", async () => {
    let approvalUrlCalled = false;
    let executeCalled = false;
    const engine = makeStubEngine({
      execute: () =>
        Effect.sync(() => {
          executeCalled = true;
          return { result: "should-not-run" };
        }),
      executeWithPause: () =>
        Effect.sync(() => {
          return makePausedResult(
            "exec_browser_1",
            FormElicitation.make({ message: "Paused", requestedSchema: {} }),
          );
        }),
    });

    await withClient(
      engine,
      ELICITATION_CAPS,
      async (client) => {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("resume");

        const result = await client.callTool({
          name: "execute",
          arguments: { code: "needs-inline-approval" },
        });
        expect(result.structuredContent).toMatchObject({
          status: "user_approval_required",
          executionId: "exec_browser_1",
          approvalUrl: "https://executor.test/resume/exec_browser_1",
        });
        expect(result.structuredContent).not.toHaveProperty("interaction");
        expect(executeCalled).toBe(false);
        expect(approvalUrlCalled).toBe(true);
      },
      {
        elicitationMode: {
          mode: "browser",
          approvalUrl: (executionId) => {
            approvalUrlCalled = true;
            return `https://executor.test/resume/${executionId}`;
          },
        },
      },
    );
  });

  it("engine error is surfaced as isError result", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: null,
          error: "something broke",
          logs: ["log1"],
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "bad" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("something broke");
    });
  });

  it("surfaces a code syntax error descriptively, not as an opaque internal error", async () => {
    // The runtime classifies a genuine parse error (a compile failure in
    // the user's own code) onto the success channel as ExecuteResult.error.
    // It must reach the model verbatim so it can self-correct, in contrast
    // to a genuine Effect failure, which stays opaque (see the
    // "execution failure stays opaque" test that asserts the masked form).
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: null,
          error: 'Unexpected token, expected "," (1:54)',
        }),
    });

    await withNativeClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "const { items } = await tools.search({ query: 'x' }" },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("Unexpected token");
      expect(text).toContain("(1:54)");
      expect(text).not.toContain("Internal tool error");
    });
  });

  it("resume tool is hidden in native elicitation mode", async () => {
    await withNativeClient(makeStubEngine({}), ELICITATION_CAPS, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("execute");
      expect(names).not.toContain("resume");
    });
  });
});

// ---------------------------------------------------------------------------
// Client WITHOUT elicitation (pause/resume path)
// ---------------------------------------------------------------------------

describe("MCP host server — client without elicitation (pause/resume)", () => {
  it("completed execution returns result directly", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed({
          status: "completed",
          result: { result: "done" },
        }),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "ok" },
      });
      expect(result.content).toEqual([{ type: "text", text: "done" }]);
      expect(result.isError).toBeFalsy();
    });
  });

  it("both execute and resume tools are visible", async () => {
    await withClient(makeStubEngine({}), NO_CAPS, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("execute");
      expect(names).toContain("resume");
    });
  });

  it("browser approval mode requires user approval before resume", async () => {
    let resumeCalled = false;
    const engine = makeStubEngine({
      resume: () =>
        Effect.sync(() => {
          resumeCalled = true;
          return { status: "completed", result: { result: "should-not-run" } };
        }),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_1" },
        });

        expect(resumeCalled).toBe(false);
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain("User approval required");
        expect(textOf(result)).toContain("https://executor.test/resume/exec_1");
        expect(textOf(result)).toContain(
          "Return text to the user telling them to approve the action at this approvalUrl. Only after you have prompted the user, call the `resume` tool with this executionId; `resume` will wait for the user's browser decision.",
        );
        expect(result.structuredContent).toMatchObject({
          status: "user_approval_required",
          executionId: "exec_1",
          approvalUrl: "https://executor.test/resume/exec_1",
          resumePrompt:
            "Return text to the user telling them to approve the action at this approvalUrl. Only after you have prompted the user, call the `resume` tool with this executionId; `resume` will wait for the user's browser decision.",
        });
      },
      {
        elicitationMode: {
          mode: "browser",
          approvalUrl: (executionId) => `https://executor.test/resume/${executionId}`,
        },
      },
    );
  });

  it("browser approval mode consumes a user-approved response and returns the resumed result", async () => {
    const approved = new Map<string, { action: "accept"; content?: Record<string, unknown> }>();
    const waiter = await Effect.runPromise(
      Deferred.make<{ action: "accept"; content?: Record<string, unknown> }>(),
    );
    const engine = makeStubEngine({
      resume: (executionId, response) =>
        Effect.succeed(
          executionId === "exec_1" && response.action === "accept"
            ? { status: "completed", result: { result: "resumed-after-browser" } }
            : null,
        ),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const waiting = client.callTool({
          name: "resume",
          arguments: { executionId: "exec_1" },
        });
        const response = { action: "accept" as const, content: {} };
        approved.set("exec_1", response);
        await Effect.runPromise(Deferred.succeed(waiter, response));
        const resumed = await waiting;
        expect(resumed.content).toEqual([{ type: "text", text: "resumed-after-browser" }]);
        expect(resumed.structuredContent).toMatchObject({
          status: "completed",
          result: "resumed-after-browser",
        });
      },
      {
        elicitationMode: {
          mode: "browser",
          approvalUrl: (executionId) => `https://executor.test/resume/${executionId}`,
        },
        browserApprovalStore: {
          takeResponse: (executionId) => Effect.succeed(approved.get(executionId) ?? null),
          waitForResponse: (executionId) =>
            Effect.gen(function* () {
              const response = approved.get(executionId);
              if (response) return response;
              return yield* Deferred.await(waiter);
            }),
        },
      },
    );
  });

  it("default model resume mode paused execution returns interaction metadata with executionId", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed(
          makePausedResult(
            "exec_42",
            FormElicitation.make({
              message: "Need approval",
              requestedSchema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
              },
            }),
          ),
        ),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "pause-me" },
      });
      expect(textOf(result)).toContain("exec_42");
      expect(textOf(result)).toContain("Need approval");
      expect(result.isError).toBeFalsy();

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured?.executionId).toBe("exec_42");
      expect(structured?.status).toBe("waiting_for_interaction");
      const interaction = structured.interaction as Record<string, unknown>;
      expect(interaction.instructions).toContain(
        "Ask the user for values matching requestedSchema",
      );
    });
  });

  it("default model resume mode explains empty form schemas as model-side confirmation", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed(
          makePausedResult(
            "exec_confirm",
            FormElicitation.make({ message: "Confirm integration add", requestedSchema: {} }),
          ),
        ),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "confirm-me" },
      });

      expect(textOf(result)).toContain("no browser form is waiting");
      const structured = result.structuredContent as Record<string, unknown>;
      const interaction = structured.interaction as Record<string, unknown>;
      expect(interaction.instructions).toContain("model-side confirmation gate");
      expect(interaction.instructions).toContain('action "accept"');
    });
  });

  it("resume tool completes a paused execution when model resume is explicitly enabled", async () => {
    let fallbackCalled = false;
    const engine = makeStubEngine({
      resume: (executionId, response) =>
        Effect.succeed(
          executionId === "exec_1" && response.action === "accept"
            ? { status: "completed", result: { result: "resumed-ok" } }
            : null,
        ),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_1", action: "accept", content: "{}" },
        });
        expect(result.content).toEqual([{ type: "text", text: "resumed-ok" }]);
        expect(result.isError).toBeFalsy();
        expect(fallbackCalled).toBe(false);
      },
      {
        elicitationMode: { mode: "model" },
        resumeFallback: () =>
          Effect.sync(() => {
            fallbackCalled = true;
            return null;
          }),
      },
    );
  });

  it("model resume can fall back to an owning session and return its resumed result", async () => {
    const ownerEvents: string[] = [];
    const ownerEngine = makeStubEngine({
      resume: (executionId, response) =>
        Effect.succeed(
          executionId === "exec_owner" && response.action === "accept"
            ? { status: "completed", result: { result: "owner-resumed" } }
            : null,
        ),
    });
    const engine = makeStubEngine({ resume: () => Effect.succeed(null) });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_owner", action: "accept", content: "{}" },
        });

        expect(result.content).toEqual([{ type: "text", text: "owner-resumed" }]);
        expect(result.structuredContent).toMatchObject({
          status: "completed",
          result: "owner-resumed",
        });
        expect(result.isError).toBeFalsy();
        expect(ownerEvents).toEqual(["resume-start:exec_owner", "resume-settle:exec_owner"]);
      },
      {
        elicitationMode: { mode: "model" },
        resumeFallback: (executionId, response) =>
          Effect.gen(function* () {
            ownerEvents.push(`resume-start:${executionId}`);
            const outcome = yield* ownerEngine
              .resume(executionId, response)
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => ownerEvents.push(`resume-settle:${executionId}`)),
                ),
              );
            return outcome
              ? { status: "result" as const, result: formatMcpExecutionOutcome(outcome) }
              : { status: "execution_expired" as const, ttlMs: 240_000 };
          }),
      },
    );
  });

  it("cross-session identity mismatch returns execution_forbidden and leaves owner pause untouched", async () => {
    let ownerResumeCalled = false;
    const engine = makeStubEngine({ resume: () => Effect.succeed(null) });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_owner", action: "accept", content: "{}" },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "execution_forbidden",
          executionId: "exec_owner",
        });
        expect(textOf(result)).toContain("same account and organization");
        expect(ownerResumeCalled).toBe(false);
      },
      {
        elicitationMode: { mode: "model" },
        resumeFallback: () =>
          Effect.sync(() => {
            ownerResumeCalled = false;
            return { status: "execution_forbidden" as const };
          }),
      },
    );
  });

  it("reports pause and resume lifecycle boundaries", async () => {
    const events: string[] = [];
    const approval = FormElicitation.make({ message: "Approve", requestedSchema: {} });
    const engine = makeStubEngine({
      executeWithPause: () => Effect.succeed(makePausedResult("exec_1", approval)),
      resume: () => Effect.succeed(makePausedResult("exec_2", approval)),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        await client.callTool({
          name: "execute",
          arguments: { code: "pause" },
        });
        expect(events).toEqual(["pause:exec_1"]);

        await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_1", action: "accept", content: "{}" },
        });
        expect(events).toEqual([
          "pause:exec_1",
          "resume-start:exec_1",
          "resume-settle:exec_1",
          "pause:exec_2",
        ]);
      },
      {
        elicitationMode: { mode: "model" },
        pausedExecutionHooks: {
          onExecutionPaused: (executionId) =>
            Effect.sync(() => events.push(`pause:${executionId}`)),
          onResumeStarted: (executionId) =>
            Effect.sync(() => events.push(`resume-start:${executionId}`)),
          onResumeSettled: (executionId) =>
            Effect.sync(() => events.push(`resume-settle:${executionId}`)),
        },
      },
    );
  });

  it("resume tool passes parsed content to engine", async () => {
    let receivedContent: Record<string, unknown> | undefined;
    const engine = makeStubEngine({
      resume: (_id, response) =>
        Effect.sync(() => {
          receivedContent = response.content;
          return { status: "completed", result: { result: "ok" } };
        }),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        await client.callTool({
          name: "resume",
          arguments: {
            executionId: "exec_1",
            action: "accept",
            content: JSON.stringify({ approved: true, name: "test" }),
          },
        });
        expect(receivedContent).toEqual({ approved: true, name: "test" });
      },
      { elicitationMode: { mode: "model" } },
    );
  });

  it("resume with empty content passes undefined", async () => {
    let receivedContent: Record<string, unknown> | undefined = { marker: true };
    const engine = makeStubEngine({
      resume: (_id, response) =>
        Effect.sync(() => {
          receivedContent = response.content;
          return { status: "completed", result: { result: "ok" } };
        }),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_1", action: "accept", content: "{}" },
        });
        expect(receivedContent).toBeUndefined();
      },
      { elicitationMode: { mode: "model" } },
    );
  });

  it("resume with unknown executionId returns error", async () => {
    const engine = makeStubEngine({ resume: () => Effect.succeed(null) });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: {
            executionId: "does-not-exist",
            action: "accept",
            content: "{}",
          },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("does-not-exist");
        expect(result.structuredContent).toMatchObject({
          status: "execution_not_found",
          executionId: "does-not-exist",
        });
      },
      { elicitationMode: { mode: "model" } },
    );
  });

  it("directory entry with a lost owner pause returns execution_expired", async () => {
    const engine = makeStubEngine({ resume: () => Effect.succeed(null) });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_lost", action: "accept", content: "{}" },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "execution_expired",
          executionId: "exec_lost",
          ttlMs: 240_000,
        });
        expect(textOf(result)).toContain("Approval windows last 4 minutes");
      },
      {
        elicitationMode: { mode: "model" },
        resumeFallback: () =>
          Effect.succeed({ status: "execution_expired" as const, ttlMs: 240_000 }),
      },
    );
  });

  it("directory mapping to the current session plus local miss returns execution_expired once", async () => {
    let fallbackCalls = 0;
    const engine = makeStubEngine({ resume: () => Effect.succeed(null) });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_current_lost", action: "accept", content: "{}" },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "execution_expired",
          executionId: "exec_current_lost",
        });
        expect(fallbackCalls).toBe(1);
      },
      {
        elicitationMode: { mode: "model" },
        resumeFallback: () =>
          Effect.sync(() => {
            fallbackCalls += 1;
            return { status: "execution_expired" as const, ttlMs: 240_000 };
          }),
      },
    );
  });

  it("directory read failure degrades to execution_not_found", async () => {
    const engine = makeStubEngine({ resume: () => Effect.succeed(null) });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_directory_down", action: "accept", content: "{}" },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "execution_not_found",
          executionId: "exec_directory_down",
        });
      },
      {
        elicitationMode: { mode: "model" },
        resumeFallback: () => Effect.fail("directory unavailable"),
      },
    );
  });

  it("local miss for a settled execution with no replay returns execution_already_settled", async () => {
    const engine = makeStubEngine({
      resume: () => Effect.succeed(null),
      isExecutionSettled: () => Effect.succeed(true),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_settled", action: "accept", content: "{}" },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "execution_already_settled",
          executionId: "exec_settled",
        });
        expect(textOf(result)).toContain("already settled");
      },
      { elicitationMode: { mode: "model" } },
    );
  });

  it("pause payload includes expiresAt and ttlMs when the host supplies a lease duration", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed(
          makePausedResult(
            "exec_deadline",
            FormElicitation.make({ message: "Approve soon", requestedSchema: {} }),
          ),
        ),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const before = Date.now();
        const result = await client.callTool({
          name: "execute",
          arguments: { code: "pause-with-deadline" },
        });
        const after = Date.now();
        const structured = result.structuredContent as Record<string, unknown>;
        const expiresAt = structured.expiresAt;

        expect(structured.ttlMs).toBe(60_000);
        expectString(expiresAt);
        const expiresAtMs = Date.parse(expiresAt);
        expect(expiresAtMs).toBeGreaterThanOrEqual(before + 60_000);
        expect(expiresAtMs).toBeLessThanOrEqual(after + 60_000);
        expect(textOf(result)).toContain("resumeDeadline");
        expect(textOf(result)).toContain("1 minute approval window");
        const interaction = structured.interaction as Record<string, unknown>;
        expect(interaction.instructions).toContain("Resume before");
      },
      { elicitationMode: { mode: "model" }, pausedExecutionLeaseMs: 60_000 },
    );
  });

  it("model resume mode paused UrlElicitation includes url and kind in structured output", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed(
          makePausedResult(
            "exec_99",
            UrlElicitation.make({
              message: "Please authenticate",
              url: "https://auth.example.com/callback",
              elicitationId: ElicitationId.make("elic-url-1"),
            }),
          ),
        ),
    });

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "execute",
          arguments: { code: "oauth" },
        });
        expect(textOf(result)).toContain("https://auth.example.com/callback");
        expect(textOf(result)).toContain("exec_99");

        const structured = result.structuredContent as Record<string, unknown>;
        const interaction = structured?.interaction as Record<string, unknown>;
        expect(interaction?.kind).toBe("url");
        expect(interaction?.url).toBe("https://auth.example.com/callback");
      },
      { elicitationMode: { mode: "model" } },
    );
  });
});

// ---------------------------------------------------------------------------
// Resume content parsing edge cases
// ---------------------------------------------------------------------------

describe("MCP host server — resume content parsing", () => {
  const makeResumeEngine = () => {
    let receivedContent: Record<string, unknown> | undefined = { marker: true };
    const engine = makeStubEngine({
      resume: (_id, response) =>
        Effect.sync(() => {
          receivedContent = response.content;
          return { status: "completed", result: { result: "ok" } };
        }),
    });
    return { engine, getContent: () => receivedContent };
  };

  it("array JSON is rejected (not passed as content)", async () => {
    const { engine, getContent } = makeResumeEngine();

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        await client.callTool({
          name: "resume",
          arguments: { executionId: "exec_1", action: "accept", content: "[1,2,3]" },
        });
        expect(getContent()).toBeUndefined();
      },
      { elicitationMode: { mode: "model" } },
    );
  });

  it("invalid JSON is handled gracefully (not thrown)", async () => {
    const { engine, getContent } = makeResumeEngine();

    await withClient(
      engine,
      NO_CAPS,
      async (client) => {
        const result = await client.callTool({
          name: "resume",
          arguments: {
            executionId: "exec_1",
            action: "accept",
            content: "not-valid-json",
          },
        });
        expect(getContent()).toBeUndefined();
        expect(result.isError).toBeFalsy();
      },
      { elicitationMode: { mode: "model" } },
    );
  });
});

// ---------------------------------------------------------------------------
// skills tool
// ---------------------------------------------------------------------------

describe("MCP host server — skills tool", () => {
  it("registers a skills tool alongside execute", async () => {
    await withClient(makeStubEngine({}), NO_CAPS, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("skills");
    });
  });

  it("returns the execute skill body by name", async () => {
    await withClient(makeStubEngine({}), NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "skills",
        arguments: { name: "execute" },
      });
      const text = textOf(result);
      // The how-to that the execute description used to inline.
      expect(text).toContain("## Workflow");
      expect(text).toContain("## Rules");
      expect(text).toContain("Use `emit(value)` to append user-visible output");
      expect(result.isError).toBeFalsy();
      // The body is the payload, returned ONLY as text content. Attaching a
      // partial structuredContent ({status,name}) makes clients that prefer
      // structured output surface that and drop the text, so the guide silently
      // fails to load. Pin the single-channel shape so that can't regress.
      expect(result.structuredContent).toBeUndefined();
    });
  });

  it("appends the live integration inventory to the execute skill", async () => {
    const description = [
      "Execute TypeScript in a sandboxed runtime.",
      "",
      "## Available integrations",
      "",
      "Integrations you have connected. Their tools live under `tools.<integration>.…`.",
      "- `acme`",
    ].join("\n");
    await withClient(makeStubEngine({ description }), NO_CAPS, async (client) => {
      const result = await client.callTool({ name: "skills", arguments: { name: "execute" } });
      const text = textOf(result);
      // The how-to body still comes first ...
      expect(text).toContain("## Workflow");
      // ... and the live inventory the description carries is appended.
      expect(text).toContain("## Available integrations");
      expect(text).toContain("- `acme`");
    });
  });

  it("lists available skills when called without a name", async () => {
    await withClient(makeStubEngine({}), NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "skills",
        arguments: {},
      });
      expect(textOf(result)).toContain("`execute`");
      expect(result.structuredContent).toBeUndefined();
    });
  });

  it("reports an unknown skill name as an error and lists valid names", async () => {
    await withClient(makeStubEngine({}), NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "skills",
        arguments: { name: "nope" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('No skill named "nope"');
      expect(textOf(result)).toContain("`execute`");
      expect(result.structuredContent).toBeUndefined();
    });
  });
});

describe("MCP host server — client attribution", () => {
  it("stamps the initialize-reported client identity on execution spans", async () => {
    await withTracedClient(makeStubEngine({}), async (client, spans) => {
      await client.callTool({ name: "execute", arguments: { code: "1+1" } });

      const execute = spans.find((span) => span.name === "mcp.host.tool.execute");
      expectDefined(execute);
      expect(execute.attributes.get("mcp.client.name")).toBe("test-client");
      expect(execute.attributes.get("mcp.client.version")).toBe("1.0.0");
    });
  });

  it("reports the initialize-reported identity to onClientInfoChange once", async () => {
    const reported: McpClientInfo[] = [];
    await withClient(
      makeStubEngine({}),
      NO_CAPS,
      async (client) => {
        await client.callTool({ name: "execute", arguments: { code: "1+1" } });
        expect(reported).toEqual([{ name: "test-client", version: "1.0.0" }]);
      },
      {
        onClientInfoChange: (clientInfo) =>
          Effect.sync(() => {
            reported.push(clientInfo);
          }),
      },
    );
  });
});

describe("clientInfoFromRequestBody", () => {
  const META_KEY = "io.modelcontextprotocol/clientInfo";

  it("prefers the per-request _meta identity", () => {
    expect(
      clientInfoFromRequestBody({
        method: "tools/call",
        params: { _meta: { [META_KEY]: { name: "meta-client", version: "2.0.0" } } },
      }),
    ).toEqual({ name: "meta-client", version: "2.0.0" });
  });

  it("falls back to the initialize body's native clientInfo", () => {
    expect(
      clientInfoFromRequestBody({
        method: "initialize",
        params: { clientInfo: { name: "init-client", version: "1.2.3", title: "Init Client" } },
      }),
    ).toEqual({ name: "init-client", version: "1.2.3", title: "Init Client" });
  });

  it("decodes a malformed or absent identity to null", () => {
    expect(clientInfoFromRequestBody(null)).toBeNull();
    expect(clientInfoFromRequestBody({ method: "tools/call", params: {} })).toBeNull();
    expect(
      clientInfoFromRequestBody({
        method: "tools/call",
        params: { _meta: { [META_KEY]: { version: "no-name" } } },
      }),
    ).toBeNull();
    // Native clientInfo is only trusted on `initialize`, where the spec puts it.
    expect(
      clientInfoFromRequestBody({
        method: "tools/call",
        params: { clientInfo: { name: "misplaced" } },
      }),
    ).toBeNull();
  });
});

describe("MCP host server — hang-visibility tracing", () => {
  it("execute emits a start marker and stamps the JSON-RPC id on execution spans", async () => {
    const engine = makeStubEngine({});

    await withTracedClient(engine, async (client, spans) => {
      await client.callTool({ name: "execute", arguments: { code: "1+1" } });

      // The start marker ends (becomes exportable) the moment execution
      // begins: a start without a matching completed `mcp.host.tool.execute`
      // is the killed-execution signal.
      const start = spans.find((span) => span.name === "mcp.host.tool.execute.start");
      expectDefined(start);
      expect(start.ended).toBe(true);
      expect(start.attributes.get("mcp.rpc.id")).toBeDefined();
      // Session id is stamped even without a transport session so the rpc id
      // is never ambiguous across sessions.
      expect(start.attributes.get("mcp.request.session_id")).toBeDefined();

      // The completion span carries the same join key.
      const execute = spans.find((span) => span.name === "mcp.host.tool.execute");
      expectDefined(execute);
      expect(execute.attributes.get("mcp.rpc.id")).toBe(start.attributes.get("mcp.rpc.id"));
      expect(execute.ended).toBe(true);
    });
  });

  it("resume emits a start marker carrying the execution id and rpc id", async () => {
    const engine = makeStubEngine({
      resume: () => Effect.succeed({ status: "completed", result: { result: "resumed" } }),
    });

    await withTracedClient(engine, async (client, spans) => {
      await client.callTool({
        name: "resume",
        arguments: { executionId: "exec-1", action: "accept" },
      });

      const start = spans.find((span) => span.name === "mcp.host.tool.resume.start");
      expectDefined(start);
      expect(start.ended).toBe(true);
      expect(start.attributes.get("mcp.execute.execution_id")).toBe("exec-1");
      expect(start.attributes.get("mcp.rpc.id")).toBeDefined();

      const resume = spans.find((span) => span.name === "mcp.host.tool.resume");
      expectDefined(resume);
      expect(resume.attributes.get("mcp.rpc.id")).toBe(start.attributes.get("mcp.rpc.id"));
    });
  });

  it("browser-approval resume emits its own start marker paired to its completion span", async () => {
    const engine = makeStubEngine({
      resume: () => Effect.succeed({ status: "completed", result: { result: "resumed" } }),
    });

    await withTracedClient(
      engine,
      async (client, spans) => {
        await client.callTool({ name: "resume", arguments: { executionId: "exec-2" } });

        // Distinct marker name: pairing start↔completion 1:1 keeps the
        // started-without-finishing query unambiguous across resume modes.
        const start = spans.find(
          (span) => span.name === "mcp.host.tool.resume.browser_approval.start",
        );
        expectDefined(start);
        expect(start.ended).toBe(true);
        expect(start.attributes.get("mcp.execute.execution_id")).toBe("exec-2");

        const completion = spans.find(
          (span) => span.name === "mcp.host.tool.resume.browser_approval",
        );
        expectDefined(completion);
        expect(completion.attributes.get("mcp.rpc.id")).toBe(start.attributes.get("mcp.rpc.id"));
      },
      {
        elicitationMode: { mode: "browser", approvalUrl: (id) => `/approve/${id}` },
        browserApprovalStore: {
          takeResponse: () => Effect.succeed({ action: "accept" as const }),
        },
      },
    );
  });
});
