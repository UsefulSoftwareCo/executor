/**
 * Axiom MCP app: OAuth discovered by the host, tools discovered live for
 * the account selected on this configured app.
 */
import { defineApp, defineProvider, oauth2 } from "apps";
import { mcpHealth, mcpRouter } from "apps/mcp";

const url = "https://mcp.axiom.co/mcp";

/** The headers that send an account's token to the server, for tools and the check alike. */
const headers = (account: { fields: { access_token: string } }) => ({
  Authorization: `Bearer ${account.fields.access_token}`,
});

/** Axiom with one OAuth method; the app sees the access token only. */
export const axiom = defineProvider({
  name: "Axiom",
  auth: {
    oauth: oauth2({ discover: url }),
  },
  // Check an account by connecting to the server with it and listing its tools.
  health: (check) => mcpHealth(check, { url, headers: headers(check.account) }),
});

export default defineApp({ accounts: { axiom } }, async ({ accounts, signal }) => ({
  tools: await mcpRouter({
    url,
    account: accounts.axiom,
    headers: headers(accounts.axiom),
    ...(signal === undefined ? {} : { signal }),
  }),
}));
