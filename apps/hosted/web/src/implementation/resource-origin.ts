/** The resource origins the server sent with this document; MCP URLs and consents use them. */
import { useAtomValue } from "@effect/atom-react";
import type { ResourceOrigins } from "@executor-js/mcp-auth/grants";
import { resourceOriginsAtom } from "../contracts/mcp.ts";

/** Every hosted document carries its resource origins, so a missing value is a host bug. */
export function useResourceOrigins(): ResourceOrigins {
  const origins = useAtomValue(resourceOriginsAtom);
  if (origins === null) throw new Error("This page was rendered without its resource origins");
  return origins;
}

/** The canonical MCP origin, where pages show MCP URLs. */
export const useMcpOrigin = (): string => useResourceOrigins().mcp[0];
