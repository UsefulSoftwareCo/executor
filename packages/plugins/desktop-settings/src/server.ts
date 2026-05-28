/**
 * @executor-js/plugin-desktop-settings/server
 *
 * Zero-server-state plugin. The Desktop Settings panel reads the active
 * Desktop sidecar Executor Server Connection and writes connection settings
 * via Electron IPC (`window.executor.*`), not through the executor server.
 * The server contribution exposes an agent-facing browser handoff tool so a
 * chat flow can still route the user to the Desktop-only settings UI without
 * moving the Basic-auth password through the model context.
 */

import { Effect, Schema } from "effect";

import { definePlugin, tool, type StaticToolSchema } from "@executor-js/sdk/core";

export interface DesktopSettingsPluginOptions {
  readonly webBaseUrl?: string;
}

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const DesktopSettingsOpenOutput = Schema.Struct({
  url: Schema.String,
  flow: Schema.String,
});

const DesktopSettingsOpenOutputStd = schemaToStaticToolSchema(DesktopSettingsOpenOutput);

const resolveWebBaseUrl = (configured: string | undefined): string =>
  (configured ?? "http://localhost:4788").replace(/\/$/, "");

export const desktopSettingsPlugin = definePlugin((options: DesktopSettingsPluginOptions = {}) => ({
  id: "desktop-settings" as const,
  packageName: "@executor-js/plugin-desktop-settings",
  storage: () => ({}),
  staticSources: () => [
    {
      id: "desktopSettings",
      kind: "executor",
      name: "Desktop Settings",
      tools: [
        tool({
          name: "openSettings",
          description:
            "Return the Desktop Settings browser URL for inspecting and configuring the desktop-sidecar Executor Server Connection. This flow must stay in the Desktop UI because password display/regeneration and server restart are Electron IPC operations; never ask the user to paste the password in chat.",
          outputSchema: DesktopSettingsOpenOutputStd,
          execute: () =>
            Effect.succeed({
              url: `${resolveWebBaseUrl(options.webBaseUrl)}/plugins/desktop-settings/`,
              flow: "Open this URL in Executor Desktop. The user can inspect the active server connection, change port/auth, or regenerate the password there; then rerun discovery/list tools to observe the refreshed connection.",
            }),
        }),
      ],
    },
  ],
}));
