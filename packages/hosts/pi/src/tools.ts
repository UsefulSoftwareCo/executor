// ---------------------------------------------------------------------------
// Executor's core tool surface, as Pi tools.
//
// The set is fixed: `execute`, `skills`, and model-mode `resume` are what
// Executor serves by default, and registering them from a literal (rather than
// mirroring `tools/list` at startup) is what lets Pi start while Executor is
// down. `parameters` mirror the server's own input schemas — schema.test.ts
// asserts that against a real Executor MCP server, so drift fails CI.
//
// Descriptions stay deliberately thin. Executor's long-form guidance lives
// server-side behind `executor_skills`, so a server-side wording fix reaches
// Pi users without republishing this package.
// ---------------------------------------------------------------------------

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Type,
  type Static,
  type TObject,
  type TOptional,
  type TSchema,
  type TString,
  type TUnsafe,
} from "typebox";

import type { ExecutorConnection } from "./connection";
import { resultText, toPiContent } from "./result";

/** Pi has no tool namespacing, so every tool carries the origin in its name. */
export const TOOL_NAME_PREFIX = "executor_";

// The annotations keep the emitted .d.ts portable: without them TypeScript
// names typebox's inferred types through its install path.
export const EXECUTE_PARAMETERS: TObject<{ code: TString }> = Type.Object({
  code: Type.String({
    description: "JavaScript to run inside Executor's sandbox.",
  }),
});

export const SKILLS_PARAMETERS: TObject<{ name: TOptional<TString> }> = Type.Object({
  name: Type.Optional(
    Type.String({
      description: 'A doc from Executor\'s own catalog, e.g. "execute". Omit to list them.',
    }),
  ),
});

export const RESUME_PARAMETERS: TObject<{
  executionId: TString;
  action: TUnsafe<"accept" | "decline" | "cancel">;
  content: TOptional<TString>;
}> = Type.Object({
  executionId: Type.String({
    description: "The execution ID from the paused executor_execute result.",
  }),
  action: StringEnum(["accept", "decline", "cancel"] as const, {
    description: "How to respond to the interaction.",
  }),
  content: Type.Optional(
    Type.String({
      description: "JSON-encoded response content for form elicitations.",
    }),
  ),
});

/** The raw MCP result, kept on `details` for logs and custom renderers. */
type ExecutorToolDetails = CallToolResult;

const executorTool = <T extends TSchema>(input: {
  readonly tool: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: T;
  readonly connection: ExecutorConnection;
}): ToolDefinition<T, ExecutorToolDetails> => ({
  name: `${TOOL_NAME_PREFIX}${input.tool}`,
  label: input.label,
  description: input.description,
  parameters: input.parameters,
  execute: async (_toolCallId, params, signal) => {
    const result = await input.connection.callTool(
      input.tool,
      params as Record<string, unknown>,
      signal,
    );
    // Pi marks a call failed only when `execute` throws, and keeps just the
    // message — so the server's error text has to ride in it. See result.ts.
    if (result.isError === true) {
      const message = resultText(result);
      throw new Error(
        message.length > 0 ? message : `Executor's ${input.tool} tool reported an error.`,
      );
    }
    return { content: toPiContent(result), details: result };
  },
});

export const registerExecutorTools = (pi: ExtensionAPI, connection: ExecutorConnection): void => {
  pi.registerTool(
    executorTool({
      tool: "execute",
      label: "Executor",
      description: [
        "Run JavaScript inside Executor to search your integration catalog and call the tools in it.",
        'Call `executor_skills({ name: "execute" })` first — it returns the guide for writing this code.',
      ].join(" "),
      parameters: EXECUTE_PARAMETERS,
      connection,
    }),
  );

  pi.registerTool(
    executorTool({
      tool: "skills",
      label: "Executor skills",
      // Spelled out because Pi models have read this as a general skill reader
      // before: github.com/UsefulSoftwareCo/executor/issues/1731.
      description: [
        "Documentation for Executor's own tools — how to write code for `executor_execute`.",
        "Not a general skill reader: it cannot reach Pi's skills, a SKILL.md on disk, or anything you authored.",
        "Call with no name to list the few docs available.",
      ].join(" "),
      parameters: SKILLS_PARAMETERS,
      connection,
    }),
  );

  pi.registerTool(
    executorTool({
      tool: "resume",
      label: "Executor resume",
      description:
        "Resume an Executor execution that paused for approval, using the executionId from the paused executor_execute result.",
      parameters: RESUME_PARAMETERS,
      connection,
    }),
  );
};

export type ExecuteParams = Static<typeof EXECUTE_PARAMETERS>;
export type SkillsParams = Static<typeof SKILLS_PARAMETERS>;
export type ResumeParams = Static<typeof RESUME_PARAMETERS>;
