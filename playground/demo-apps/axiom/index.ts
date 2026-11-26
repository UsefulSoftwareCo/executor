import { defineApp, defineProvider, oauth2 } from "apps";
import { mcpHealth, mcpRouter } from "apps/mcp";

const url = "https://mcp.axiom.co/mcp";

const headers = (account: { fields: { access_token: string } }) => ({
  Authorization: `Bearer ${account.fields.access_token}`,
});

export const axiom = defineProvider({
  name: "Axiom",
  auth: {
    oauth: oauth2({ discover: url }),
  },
  health: (check) => mcpHealth(check, { url, headers: headers(check.account) }),
});

export default defineApp({ user: { accounts: { axiom } } }, async ({ user, signal }) => {
  if (user === undefined) return {};
  const account = user.accounts.axiom;
  return {
    tools: await mcpRouter({
      url,
      account,
      headers: headers(account),
      ...(signal === undefined ? {} : { signal }),
    }),
  };
});
