import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { McpServerMove } from "@executor-js/react/api/mcp-server-move";

import { v2ImportAtom } from "./auth";

// ---------------------------------------------------------------------------
// The selected org's MCP server in Executor v2, for the shared connect surfaces
// (`McpInstallCard`, the onboarding setup page). Set only for an org v2 has
// imported, and only where the server knows v2's MCP origin (`v2McpUrl`).
// v2's MCP URL names no organization: agents choose it (`v2Slug`) at sign-in.
// ---------------------------------------------------------------------------

export function useV2McpMove(): McpServerMove | null {
  const result = useAtomValue(v2ImportAtom);
  const moved = AsyncResult.isSuccess(result) ? result.value.moved : null;
  const url = moved?.v2McpUrl;
  const organization = moved?.v2Slug;
  return useMemo(
    () =>
      url === undefined || organization === undefined
        ? null
        : { url, destination: "Executor v2", previous: "v1", organization },
    [url, organization],
  );
}
