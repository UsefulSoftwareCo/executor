/** HTTP MCP helpers. Requires the optional @modelcontextprotocol/client and @modelcontextprotocol/core peers. */
import type { OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect } from "effect";
import type { McpHealthOptions } from "./contracts/mcp.ts";
import type { AccountCheckContext, AuthMethods } from "./contracts/provider.ts";
import { mcpCatalog, type McpCatalogOptions } from "./implementation/mcp-catalog.ts";
import { mcpHealthEffect } from "./implementation/mcp.ts";
export type { McpCatalogOptions } from "./implementation/mcp-catalog.ts";
export {
  McpCredentialsUnverified,
  McpError,
  type McpHealthOptions,
  type McpToolContext,
  type McpToolsOptions,
  type McpToolResult,
} from "./contracts/mcp.ts";

/**
 * A router over a server's tools for the selected account. Its title, description and
 * instructions come from the server. Kinds override uncertain upstream read-only hints.
 */
export const mcpRouter = (options: McpCatalogOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    mcpCatalog(options, kinds),
    options.signal === undefined ? {} : { signal: options.signal },
  );

/**
 * A provider `health` check for an MCP server. Pass the check context `health` receives, then the
 * server's `url` and the `headers` that send the account's credentials:
 * `health: (check) => mcpHealth(check, { url, headers: headers(check.account) })`.
 *
 * It connects with those headers, initializes, and reads the first page of tools, then does the
 * same without any headers. No tool runs. The check passes only when the server accepts the account
 * and refuses the attempt without credentials. A refused account throws `ProviderError`, as HTTP
 * helpers do. An unreachable or unusable server throws `McpError`, and a request Executor's network
 * refuses throws `NetworkRefused`. A server that also answers without credentials, or whose answer
 * to that attempt is not a refusal, throws `McpCredentialsUnverified`. Each of these errors means
 * the check could not verify the account, and the account form explains why. Send credentials only
 * in `headers`; the attempt without them uses the same `url`. The check context's `signal` cancels
 * both attempts, and they share one budget that ends early enough before its `deadline` to report a
 * server that did not answer in time. `timeoutMs` can only shorten that budget.
 */
export const mcpHealth = <Auth extends AuthMethods>(
  check: AccountCheckContext<Auth>,
  options: McpHealthOptions,
): Promise<void> => Effect.runPromise(mcpHealthEffect(check, options), { signal: check.signal });

export type { OperationKinds } from "./implementation/protocol-operations.ts";
