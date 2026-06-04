import { Effect } from "effect";

import {
  type AnyIntegrationPlugin,
  AuthTemplateSlug,
  ConnectionName,
  type CredentialProvider,
  definePlugin,
  type ExecutorConfig,
  type ExecutorSDK,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
  Subject,
  Tenant,
} from "../src";
import { openapiPlugin, variable } from "../src/openapi";

/* A throwaway 1Password provider — the value lives in 1Password; we resolve an
 * opaque id on demand and never store it. Read-only from our side. The id shape
 * (here an op:// path) is the provider's business; core never parses it. */
const onepassword: CredentialProvider = {
  key: ProviderKey.make("1password"),
  writable: false,
  get: (_id) => Effect.succeed(null), // stub: would resolve the id → the secret
  list: () =>
    Effect.succeed([{ id: ProviderItemId.make("op://Private/Vercel/credential"), name: "Vercel (Private)" }]),
};

/* A throwaway mcp plugin so the dynamic-tools scenario has a `kind: "mcp"`.
 * Same generic `add` dispatch as openapi — a new kind is just another plugin. */
type McpIntegration = { slug: IntegrationSlug; description: string; url: string };
const mcpPlugin = definePlugin({
  kind: "mcp",
  add: (input: {
    kind: "mcp";
    slug: IntegrationSlug;
    description: string;
    url: string;
  }): McpIntegration => ({ slug: input.slug, description: input.description, url: input.url }),
  // Called at create/refresh: dial the server with the credential and list its
  // tools. The SDK stamps addresses + persists; listing never calls back here.
  resolveTools: ({ integration, getValue }) =>
    Effect.gen(function* () {
      yield* getValue(); // would authenticate to integration.url
      return [{ name: ToolName.make("queryDataset"), description: `Discovered from ${integration.url}` }];
    }),
});

/* Mirrors the real createExecutor: generic over the plugin tuple, `const` so each
 * plugin's literal kind reaches the `add` projection. */
function createExecutor<const TPlugins extends readonly AnyIntegrationPlugin[]>(
  config: ExecutorConfig<TPlugins>,
): ExecutorSDK<TPlugins> {
  void config;
  return {} as ExecutorSDK<TPlugins>;
}

const executor = createExecutor({
  tenant: Tenant.make("acme"),
  subject: Subject.make("rhys"), // required for owner: "user" writes
  redirectUri: "https://gateway.example.com/oauth/callback",
  plugins: [openapiPlugin, mcpPlugin],
  providers: [onepassword], // a "default" writable store is assumed for pasted values
  onElicitation: "accept-all", // tests/CLI default; real hosts pass a handler
});

export const program = Effect.gen(function* () {
  /* ── catalog: integrations are API surfaces + their auth templates ───────── */

  yield* executor.integrations.add({
    kind: "openapi",
    slug: IntegrationSlug.make("vercel"),
    description: "Vercel API",
    authenticationTemplate: [
      {
        slug: AuthTemplateSlug.make("token"),
        type: "apiKey",
        headers: { Authorization: ["Bearer ", variable("token")] },
      },
    ],
  });

  // Google is ONE integration — a bundle of its APIs (Gmail, Calendar, Drive).
  // One OAuth token covers them all, so 1 connection : 1 integration still holds.
  yield* executor.integrations.add({
    kind: "openapi",
    slug: IntegrationSlug.make("google"),
    description: "Google (Gmail, Calendar, Drive)",
    authenticationTemplate: [
      {
        slug: AuthTemplateSlug.make("oauth"),
        type: "oauth",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: [
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar",
        ],
      },
    ],
  });

  // github offers BOTH a PAT (apiKey) and oauth — scenario F
  yield* executor.integrations.add({
    kind: "openapi",
    slug: IntegrationSlug.make("github"),
    description: "GitHub",
    authenticationTemplate: [
      {
        slug: AuthTemplateSlug.make("pat"),
        type: "apiKey",
        headers: { Authorization: ["Bearer ", variable("token")] },
      },
      {
        slug: AuthTemplateSlug.make("oauth"),
        type: "oauth",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo"],
      },
    ],
  });

  // an MCP server — no spec, tools come from the live server
  yield* executor.integrations.add({
    kind: "mcp",
    slug: IntegrationSlug.make("axiom"),
    description: "Axiom MCP",
    url: "https://mcp.axiom.co",
  });

  /* ── A — personal API key ────────────────────────────────────────────────
   * One call: a credential born bound to Vercel. The template's `Bearer {token}`
   * is applied lazily at execute time, never stored. */
  yield* executor.connections.create({
    owner: "user",
    name: ConnectionName.make("rhys-vercel"),
    integration: IntegrationSlug.make("vercel"),
    template: AuthTemplateSlug.make("token"),
    value: "eaedaed",
  });
  yield* executor.execute(ToolAddress.make("tools.vercel.user.rhys-vercel.listProjects"), { limit: 5 });

  /* ── B — shared org API key (same code, owner: "org") ────────────────────── */
  yield* executor.connections.create({
    owner: "org",
    name: ConnectionName.make("company-vercel"),
    integration: IntegrationSlug.make("vercel"),
    template: AuthTemplateSlug.make("token"),
    value: "org_xxx",
  });

  /* ── C — Google via OAuth, one bundled integration ───────────────────────
   * One credential for the "google" integration covers gmail + calendar tools —
   * no reuse, no second connect. */
  const googleApp = yield* executor.oauth.createClient({
    owner: "org",
    slug: OAuthClientSlug.make("google-app"),
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar",
    ],
    grant: "authorization_code",
    clientId: "abc",
    clientSecret: "shh",
  });
  const started = yield* executor.oauth.start({
    client: googleApp,
    owner: "user",
    name: ConnectionName.make("rhys-google"),
    integration: IntegrationSlug.make("google"),
    template: AuthTemplateSlug.make("oauth"),
  });
  if (started.status === "redirect") {
    yield* executor.oauth.complete({ state: started.state, code: "..." });
  }
  // a tool that may elicit — override the handler per-call
  yield* executor.execute(
    ToolAddress.make("tools.google.user.rhys-google.gmail_send"),
    { to: "a@b.com", subject: "hi" },
    {
      onElicitation: ({ request }) =>
        Effect.succeed(
          request._tag === "FormElicitation"
            ? { action: "accept", content: {} }
            : { action: "decline" },
        ),
    },
  );
  yield* executor.execute(ToolAddress.make("tools.google.user.rhys-google.calendar_listEvents"), {});

  /* ── D — choice mode: org default + personal override on the same integration
   * A's user connection and B's org connection are both for vercel, so both
   * addresses exist; the <owner> segment selects which. The agent names it. */
  // tools.vercel.org.company-vercel.listProjects   (shared)
  // tools.vercel.user.rhys-vercel.listProjects     (personal override)

  /* ── E — MCP without OAuth: per-connection tools, persisted ──────────────
   * `create` runs the mcp plugin's `resolveTools` (dials the server) and persists
   * the result. `tools.list` then just reads. `connections.refresh` re-discovers
   * when the server's tools change. */
  yield* executor.connections.create({
    owner: "org",
    name: ConnectionName.make("axiom-key"),
    integration: IntegrationSlug.make("axiom"),
    template: AuthTemplateSlug.make("apiKey"),
    value: "axm_...",
  });
  const axiomTools = yield* executor.tools.list({
    owner: "org",
    connection: ConnectionName.make("axiom-key"),
    integration: IntegrationSlug.make("axiom"),
  });
  void axiomTools; // persisted; each carries its address  tools.axiom.org.axiom-key.<tool>

  // later, the server's tools changed — refresh THIS connection's tools
  yield* executor.connections.refresh({
    owner: "org",
    name: ConnectionName.make("axiom-key"),
    integration: IntegrationSlug.make("axiom"),
  });

  /* ── F — multi-template integration: `template` picks the auth method ──── */
  yield* executor.connections.create({
    owner: "user",
    name: ConnectionName.make("rhys-pat"),
    integration: IntegrationSlug.make("github"),
    template: AuthTemplateSlug.make("pat"), // ← PAT, not oauth
    value: "ghp_...",
  });

  /* ── G — value lives in 1Password: reference it, never store it ──────────
   * Browse 1Password, pick an entry's opaque id, create a Vercel connection
   * backed by it. The value is resolved on demand and never stored by us. */
  const opItems = yield* executor.providers.items(ProviderKey.make("1password"));
  const vercelItem = opItems.find((e) => e.name.includes("Vercel"));
  yield* executor.connections.create({
    owner: "user",
    name: ConnectionName.make("rhys-vercel-1p"),
    integration: IntegrationSlug.make("vercel"),
    template: AuthTemplateSlug.make("token"),
    from: { provider: ProviderKey.make("1password"), id: vercelItem?.id ?? ProviderItemId.make("") },
  });
});
