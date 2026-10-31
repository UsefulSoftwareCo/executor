/** A provider whose host credential can coexist with ordinary connect methods. */
export const provisionedSource = (
  provisioned: boolean,
  mixed = false,
  oauthOrigin?: string,
) => `import { defineApp, defineProvider, object, query, router, secrets, string, oauth2 } from "apps";
const access = defineProvider({ name: "Host access", auth: {
  key: secrets({ label: "Host access", ${provisioned ? "provisioned: true," : ""} fields: object({ token: string() }) }),
  ${mixed ? 'manual: secrets({ label: "Manual key", fields: object({ token: string() }) }),' : ""}
${oauthOrigin === undefined ? "" : `browser: oauth2({ discover: ${JSON.stringify(oauthOrigin + "/mcp")} }),`}
} });
export default defineApp({ user: { accounts: { service: access } } }, {
  tools: router({ present: query({ input: object({}) }, async (ctx) => ({ valid: ctx.user.accounts.service.fields.token === "fixture-host-key" })) }),
});`;
