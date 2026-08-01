/**
 * @executor-js/plugin-browser-bridge/server
 *
 * Static integration `chrome` — reverse desktop bridge tools.
 * Requires a live extension session (path B). Agents call e.g. tools.chrome.snapshot.
 */

import { Effect, Schema } from "effect";

import { definePlugin, tool, type StaticToolSchema } from "@executor-js/sdk/core";

import { callTool, listSessionsForUser, sessionPublicView } from "./store";

export interface BrowserBridgePluginOptions {
  readonly callTimeoutMs?: number;
}

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const AnyObject = Schema.Record(Schema.String, Schema.Unknown);

const CallInput = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(AnyObject),
  sessionId: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
});
const CallInputStd = schemaToStaticToolSchema(CallInput);

const StatusOutput = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      kind: Schema.String,
      transport: Schema.String,
      createdAt: Schema.Number,
      lastSeenAt: Schema.Number,
      pending: Schema.Number,
      inflight: Schema.Number,
    }),
  ),
  note: Schema.String,
});
const StatusOutputStd = schemaToStaticToolSchema(StatusOutput);

const CallOutput = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const CallOutputStd = schemaToStaticToolSchema(CallOutput);

type ExecCtx = {
  readonly ctx: {
    readonly owner: { readonly tenant: string; readonly subject: string | null };
  };
};

function userIdFrom(context: ExecCtx): string {
  // Prefer subject (API key / user). Fall back to tenant so org-only scopes still key something.
  return String(context.ctx.owner.subject || context.ctx.owner.tenant || "anonymous");
}

async function invoke(
  userId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  sessionId: string | undefined,
  timeoutMs: number,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const result = await callTool({
      userId,
      sessionId,
      tool: toolName,
      args: args || {},
      timeoutMs,
    });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export const browserBridgePlugin = definePlugin((options: BrowserBridgePluginOptions = {}) => {
  const defaultTimeout = options.callTimeoutMs ?? 45_000;

  return {
    id: "browser-bridge" as const,
    packageName: "@executor-js/plugin-browser-bridge",
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "chrome",
        kind: "executor",
        name: "Chrome (desktop reverse)",
        description:
          "Drive the user's real Chrome via Executor Browser extension reverse channel. Requires a live bridge session (extension Connect, path B).",
        tools: [
          tool({
            name: "status",
            description:
              "List live desktop browser-bridge sessions. Empty means the extension is not connected with reverse drive.",
            outputSchema: StatusOutputStd,
            execute: (_args, context) =>
              Effect.sync(() => {
                const userId = userIdFrom(context as ExecCtx);
                const sessions = listSessionsForUser(userId).map(sessionPublicView);
                return {
                  sessions,
                  note:
                    sessions.length === 0
                      ? "No live reverse session. Open Executor Browser → Connect (Extension B)."
                      : `${sessions.length} session(s) live`,
                };
              }),
          }),
          tool({
            name: "call",
            description:
              "Invoke a browser tool on the live extension session. Tools: ping, tabs.list, tabs.open, navigate, snapshot, click, type, screenshot. Prefer snapshot over screenshot.",
            inputSchema: CallInputStd,
            outputSchema: CallOutputStd,
            execute: (input, context) =>
              Effect.promise(() => {
                const userId = userIdFrom(context as ExecCtx);
                const body = input as {
                  tool: string;
                  args?: Record<string, unknown>;
                  sessionId?: string;
                  timeoutMs?: number;
                };
                return invoke(
                  userId,
                  body.tool,
                  body.args,
                  body.sessionId,
                  body.timeoutMs ?? defaultTimeout,
                );
              }),
          }),
          tool({
            name: "snapshot",
            description:
              "A11y-ish DOM snapshot of the active agent tab. Prefer this over screenshot.",
            inputSchema: schemaToStaticToolSchema(
              Schema.Struct({
                tabId: Schema.optional(Schema.Number),
                sessionId: Schema.optional(Schema.String),
              }),
            ),
            outputSchema: CallOutputStd,
            execute: (input, context) =>
              Effect.promise(() => {
                const userId = userIdFrom(context as ExecCtx);
                const args = { ...((input as Record<string, unknown>) || {}) };
                const sessionId = args.sessionId as string | undefined;
                delete args.sessionId;
                return invoke(userId, "snapshot", args, sessionId, defaultTimeout);
              }),
          }),
          tool({
            name: "navigate",
            description: "Navigate a tab (or open newTab) to a URL in the user's Chrome.",
            inputSchema: schemaToStaticToolSchema(
              Schema.Struct({
                url: Schema.String,
                tabId: Schema.optional(Schema.Number),
                newTab: Schema.optional(Schema.Boolean),
                sessionId: Schema.optional(Schema.String),
              }),
            ),
            outputSchema: CallOutputStd,
            execute: (input, context) =>
              Effect.promise(() => {
                const userId = userIdFrom(context as ExecCtx);
                const args = { ...((input as Record<string, unknown>) || {}) };
                const sessionId = args.sessionId as string | undefined;
                delete args.sessionId;
                return invoke(userId, "navigate", args, sessionId, defaultTimeout);
              }),
          }),
          tool({
            name: "click",
            description: "Click by coordinates, CSS selector, or snapshot nodeIndex.",
            inputSchema: schemaToStaticToolSchema(
              Schema.Struct({
                x: Schema.optional(Schema.Number),
                y: Schema.optional(Schema.Number),
                selector: Schema.optional(Schema.String),
                nodeIndex: Schema.optional(Schema.Number),
                tabId: Schema.optional(Schema.Number),
                sessionId: Schema.optional(Schema.String),
              }),
            ),
            outputSchema: CallOutputStd,
            execute: (input, context) =>
              Effect.promise(() => {
                const userId = userIdFrom(context as ExecCtx);
                const args = { ...((input as Record<string, unknown>) || {}) };
                const sessionId = args.sessionId as string | undefined;
                delete args.sessionId;
                return invoke(userId, "click", args, sessionId, defaultTimeout);
              }),
          }),
          tool({
            name: "type",
            description: "Type text into the focused input (or selector). Optional submit.",
            inputSchema: schemaToStaticToolSchema(
              Schema.Struct({
                text: Schema.String,
                selector: Schema.optional(Schema.String),
                submit: Schema.optional(Schema.Boolean),
                tabId: Schema.optional(Schema.Number),
                sessionId: Schema.optional(Schema.String),
              }),
            ),
            outputSchema: CallOutputStd,
            execute: (input, context) =>
              Effect.promise(() => {
                const userId = userIdFrom(context as ExecCtx);
                const args = { ...((input as Record<string, unknown>) || {}) };
                const sessionId = args.sessionId as string | undefined;
                delete args.sessionId;
                return invoke(userId, "type", args, sessionId, defaultTimeout);
              }),
          }),
        ],
      },
    ],
  };
});
