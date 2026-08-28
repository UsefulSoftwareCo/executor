import React from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpAppsShell } from "./shell-app";

/**
 * The shell's MCP-Apps entry point: connect, then render whatever the host
 * sends.
 *
 * `tool-input` and `tool-result` are ONE-SHOT notifications. A host is free to
 * send them the instant the handshake completes — `AppBridge.oninitialized`
 * fires on `ui/notifications/initialized`, which `App.connect()` sends before it
 * resolves. `McpAppsShell` registers its handlers in an effect, which cannot run
 * until React has mounted it, which is at best a frame later. A prompt host
 * therefore delivers the artifact into a void, and the shell sits on its loading
 * state forever.
 *
 * That is not hypothetical: it is exactly what the console's artifact page does,
 * and the ext-apps SDK warns about the race by name ("handler registered after
 * connect() completed the ui/initialize handshake").
 *
 * So the notifications are captured HERE, in `onAppCreated` — the callback the
 * SDK provides for precisely this, running before `connect()` — and replayed
 * into the shell once it has mounted and registered its own handlers. Buffering
 * rather than racing means the shell's handlers stay where they belong (with the
 * state they drive) and no host has to know how fast this app mounts.
 */

type ToolInput = { arguments?: Record<string, unknown> };

/** What arrived before the shell was ready to hear it. */
type EarlyDelivery = {
  toolInput?: ToolInput;
  toolResult?: CallToolResult;
  /** Set once the shell has taken over; further notifications go straight through. */
  drain?: (delivery: { toolInput?: ToolInput; toolResult?: CallToolResult }) => void;
};

const captureEarlyDelivery = (app: App, early: EarlyDelivery) => {
  // `addEventListener`, not the `on*` setters: the shell replaces those with its
  // own handlers, and this listener must survive that.
  app.addEventListener("toolinput", (params) => {
    if (early.drain) early.drain({ toolInput: params });
    else early.toolInput = params;
  });
  app.addEventListener("toolresult", (params) => {
    const result = params as CallToolResult;
    if (early.drain) early.drain({ toolResult: result });
    else early.toolResult = result;
  });
};

function ConnectedShellApp() {
  const earlyRef = React.useRef<EarlyDelivery>({});
  const { app, error: connectionError } = useApp({
    appInfo: { name: "Executor Shell", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => captureEarlyDelivery(created, earlyRef.current),
  });

  // Replay once, after the shell's own handlers are in place. The effect runs
  // after the child's effects, which is exactly the ordering this needs.
  React.useEffect(() => {
    if (!app) return;
    const early = earlyRef.current;
    const deliver = (delivery: { toolInput?: ToolInput; toolResult?: CallToolResult }) => {
      if (delivery.toolInput) app.ontoolinput?.(delivery.toolInput);
      if (delivery.toolResult) app.ontoolresult?.(delivery.toolResult);
    };
    deliver(early);
    early.toolInput = undefined;
    early.toolResult = undefined;
    early.drain = deliver;
  }, [app]);

  if (connectionError) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-destructive text-sm">Connection error: {connectionError.message}</div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-sm text-muted-foreground">Connecting</div>
      </div>
    );
  }

  return <McpAppsShell app={app} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectedShellApp />
  </React.StrictMode>,
);
