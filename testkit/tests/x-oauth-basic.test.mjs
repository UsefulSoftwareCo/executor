import { mcpTest } from "../src/testkit.mjs";
import { selfhost } from "./execute.test.mjs";

const uniqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

mcpTest(
  "x emulator OAuth client-credentials clients authenticate with HTTP Basic",
  selfhost,
  async (mcp) => {
    const slug = uniqueId("x-oauth-basic");
    const instance = slug;
    const baseUrl = `https://emulators.dev/x/${instance}`;

    mcp.say(
      "Register the X emulator OpenAPI integration, create a confidential OAuth client, and start a client-credentials connection through Executor itself.",
    );

    const started = await mcp.call("execute", {
      code: `
const slug = ${JSON.stringify(slug)};
const baseUrl = ${JSON.stringify(baseUrl)};
const authorizationUrl = baseUrl + "/2/oauth2/authorize";
const tokenUrl = baseUrl + "/2/oauth2/token";

const added = await tools.executor.openapi.addSpec({
  spec: { kind: "url", url: "https://x.emulators.dev/2/openapi.json" },
  slug,
  baseUrl,
  authenticationTemplate: [{
    slug: "oauth2",
    type: "oauth",
    authorizationUrl,
    tokenUrl,
    scopes: [],
  }],
});

const client = await tools.executor.coreTools.oauth.clients.create({
  owner: "org",
  slug: slug + "-client",
  authorizationUrl,
  tokenUrl,
  grant: "client_credentials",
  clientId: "x-confidential-client",
  clientSecret: "x-confidential-secret",
});

const connection = await tools.executor.coreTools.oauth.start({
  client: slug + "-client",
  clientOwner: "org",
  owner: "org",
  name: "machine",
  integration: slug,
  template: "oauth2",
});

return JSON.stringify({ added, client, connection }, null, 2);
`,
    });

    mcp.expect(started.text).toContain("Execution paused: Add an OpenAPI integration");

    const resumed = await mcp.approvePaused(started.text);
    const ledger = await fetch(`${baseUrl}/_emulate/ledger?limit=20`).then((r) => r.json());
    const tokenRequest = ledger.entries.find(
      (entry) =>
        entry.path === "/2/oauth2/token" &&
        entry.request?.body?.grant_type === "client_credentials",
    );

    if (!resumed.ok) {
      mcp.expect(Boolean(tokenRequest)).toBe(true);
      mcp.expect(Object.hasOwn(tokenRequest.request.body, "client_secret")).toBe(false);
    }

    mcp.expect(resumed.ok).toBe(true);
    mcp.expect(resumed.text).toContain('"status": "connected"');

    mcp.expect(Boolean(tokenRequest)).toBe(true);
    mcp.expect(tokenRequest.request.headers.authorization).toBe("[redacted]");
    mcp.expect(Object.hasOwn(tokenRequest.request.body, "client_secret")).toBe(false);
  },
);
