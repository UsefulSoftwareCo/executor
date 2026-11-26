import { useAtomValue } from "@effect/atom-react";
import type { ResourceOrigins } from "@executor-js/mcp-auth/grants";
import { resourceOriginsAtom } from "../contracts/mcp.ts";

export function useResourceOrigins(): ResourceOrigins {
  const origins = useAtomValue(resourceOriginsAtom);
  if (origins === null) throw new Error("This page was rendered without its resource origins");
  return origins;
}

export const useMcpOrigin = (): string => useResourceOrigins().mcp[0];
