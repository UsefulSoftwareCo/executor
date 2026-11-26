import { SourceFiles } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { packageFile } from "@executor-js/app-templates";
import type { HostedApiDocument } from "../contracts/api.ts";

const managementIndex = (
  origin: string,
  apiKey = false,
) => `import { defineApp, dynamicSkills } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import { wellKnownSkills } from "apps/skills";
import { provider } from "./provider.ts";
import configuration from "./openapi.json";

export default defineApp({ user: { accounts: { service: provider } } }, async (context) => {
  const account = context.user.accounts.service;
  const tools = liveOpenapiRouter({
    ...configuration,
    cache: context.cache,
    ${
      apiKey
        ? `account: account.method === "apiKey"
      ? { ...account, method: "oauth", fields: { access_token: account.fields.token } }
      : account,
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (account.method === "apiKey" && new URL(request.url).origin === configuration.allowedOrigin) request.headers.set("X-Executor-Organization", account.fields.organization);
      return context.fetch(request);
    },
    // A managed key belongs to one organization, so callers need not look it up first.
    ...(account.method === "apiKey" ? { parameterDefaults: { path: { organization: account.fields.organization } } } : {}),`
        : `account,
    fetch: context.fetch,`
    }
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const skills = dynamicSkills({ list: () => wellKnownSkills({ url: ${JSON.stringify(`${origin}/.well-known/agent-skills/index.json`)}, cache: context.cache, fetch: context.fetch, signal: context.signal }) });
  return { tools, dynamicSkills: skills };
});
`;

const managementConfiguration = (origin: string, document: HostedApiDocument) =>
  JSON.stringify(
    {
      source: { url: `${origin}/openapi.json` },
      allowedOrigin: origin,
      securitySchemes: document.components.securitySchemes,
      methods: {
        apiKey: [{ scheme: "browserSession", field: "token", part: "value", prefix: "" }],
      },
      oauth: ["oauth"],
      baseUrl: origin,
    },
    null,
    2,
  );

export const executorAppSource = (origin: string, document: HostedApiDocument) =>
  Effect.succeed({
    files: SourceFiles.make([
      { path: "index.ts", content: managementIndex(origin) },
      { path: "openapi.json", content: managementConfiguration(origin, document) },
      packageFile("executor"),
      {
        path: "provider.ts",
        content: `import { defineProvider, object, string, secrets, oauth2 } from "apps"

export const provider = defineProvider({ name: "Executor", auth: {
  ["apiKey"]: secrets({ label: "API key", fields: object({ ["token"]: string({ minLength: 1 }) }) }),
  ["oauth"]: oauth2({
  "discover": ${JSON.stringify(`${origin}/api`)}
})
} })
`,
      },
    ]),
  });

export const defaultExecutorAppSource = (origin: string, document: HostedApiDocument) =>
  Effect.succeed({
    files: SourceFiles.make([
      {
        path: "index.ts",
        content: managementIndex(origin, true),
      },
      {
        path: "provider.ts",
        content: `import { defineProvider, object, string, secrets, oauth2 } from "apps";

export const provider = defineProvider({ name: "Executor", auth: {
  apiKey: secrets({ label: "Executor API key", fields: object({ token: string(), organization: string() }) }),
  oauth: oauth2({ discover: ${JSON.stringify(`${origin}/api`)} }),
} });
`,
      },
      { path: "openapi.json", content: managementConfiguration(origin, document) },
      packageFile("executor"),
    ]),
  });
