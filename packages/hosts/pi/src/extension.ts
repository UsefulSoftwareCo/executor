// ---------------------------------------------------------------------------
// @executor-js/pi — Executor's tools, inside Pi.
//
// Pi ships no MCP client, so this extension is the bridge: it registers
// Executor's small `execute` / `skills` / `resume` surface as Pi tools and
// forwards each call over MCP. Configuration is environment-only; see config.ts.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ENDPOINT_ENV_VAR, resolvePiExecutorConfig } from "./config";
import { createExecutorConnection, type ExecutorConnection } from "./connection";
import { registerExecutorTools } from "./tools";

// Pi only needs the default export. The pieces are re-exported so each can be
// tested on its own — resolution, the connection, and the registered schemas —
// without standing up a Pi session for it.
export {
  ENDPOINT_ENV_VAR,
  TOKEN_ENV_VARS,
  resolvePiExecutorConfig,
  type PiExecutorConfig,
  type PiTokenSource,
  type ResolvedPiExecutorConfig,
} from "./config";
export { createExecutorConnection, type ExecutorConnection } from "./connection";
export { registerExecutorTools, TOOL_NAME_PREFIX } from "./tools";

export interface StatusReport {
  readonly message: string;
  readonly type: "info" | "error";
}

/** What `/executor` prints: where we point, and whether it actually answers. */
export const describeConnection = async (connection: ExecutorConnection): Promise<StatusReport> => {
  const resolved = connection.resolved;
  if (!resolved.ok)
    return { message: `Executor is not configured. ${resolved.reason}`, type: "error" };

  const auth = resolved.config.authorization === null ? "no token" : "token set";
  const target = `${resolved.config.endpoint} (${auth})`;
  try {
    const names = await connection.listToolNames();
    return { message: `Executor connected: ${target}\nTools: ${names.join(", ")}`, type: "info" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { message: `Executor is unreachable: ${target}\n${detail}`, type: "error" };
  }
};

export default function executorExtension(pi: ExtensionAPI): void {
  const connection = createExecutorConnection(resolvePiExecutorConfig(process.env));

  registerExecutorTools(pi, connection);

  pi.registerCommand("executor", {
    description: `Check this session's Executor connection (${ENDPOINT_ENV_VAR}).`,
    handler: async (_args, ctx) => {
      const report = await describeConnection(connection);
      ctx.ui.notify(report.message, report.type);
    },
  });

  // Pi owns the process lifetime; close the session deterministically rather
  // than leaving Executor to time it out.
  pi.on("session_shutdown", async () => {
    await connection.close();
  });
}
