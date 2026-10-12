import * as React from "react";

// Where the active organization's MCP server now lives, when the host knows
// the organization has moved to another deployment (cloud: an org imported
// into Executor v2). Hosts without moves leave it unset, and the connect
// surfaces show only this server. Purely a UI hint for which URL to hand
// agents; this server keeps answering either way.
export interface McpServerMove {
  /** The MCP server URL agents should connect to instead of this one. */
  readonly url: string;
  /** Where the organization moved, as the user knows it (e.g. "Executor v2"). */
  readonly destination: string;
  /** This deployment, as the user knows it (e.g. "v1"). */
  readonly previous: string;
  /** The organization to choose when signing in to the new server, whose
   *  OAuth sign-in picks the organization rather than the URL. */
  readonly organization: string;
}

const McpServerMoveContext = React.createContext<McpServerMove | null>(null);

export function McpServerMoveProvider(
  props: React.PropsWithChildren<{ readonly move: McpServerMove | null }>,
) {
  return (
    <McpServerMoveContext.Provider value={props.move}>
      {props.children}
    </McpServerMoveContext.Provider>
  );
}

/** The active organization's moved MCP server, or `null` when it has not moved. */
export function useMcpServerMove(): McpServerMove | null {
  return React.useContext(McpServerMoveContext);
}
