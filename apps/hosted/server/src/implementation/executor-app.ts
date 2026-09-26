import { SourceFiles, type SourceFile } from "@executor-js/sdk/core";
import { Effect } from "effect";
/** Executor uses the same source generator, provider accounts and deployments as other API apps. */
import type { HostedApiDocument } from "../contracts/api.ts";

/** The catalog retains the ordinary OAuth connection for explicitly installed copies. */
const managementIndex = (
  origin: string,
  apiKey = false,
) => `import { defineApp, dynamicSkills } from "apps";
import { liveOpenapiOperations } from "apps/openapi";
import { wellKnownSkills } from "apps/skills";
import { provider } from "./provider.ts";
import configuration from "./openapi.json";
import { frameworkQueries } from "./framework.ts";
import reference from "./framework-reference.json";

export default defineApp({ accounts: { service: provider } }, async (context) => {
  const account = context.accounts.service;
  const operations = liveOpenapiOperations({
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
  const skills = dynamicSkills({ list: () => wellKnownSkills({ url: ${JSON.stringify(`${origin}/.well-known/agent-skills/index.json`)}, fetch: context.fetch, signal: context.signal }) });
  return { ...operations, dynamicSkills: skills, queries: { ...operations.queries, ...frameworkQueries(reference) } };
});
`;

/**
 * Live OpenAPI settings for this installation's own API. The document is ours, so its origin and
 * credential placement are declared here rather than inferred from the document.
 */
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

/** The version installed from the catalog. Existing untouched copies are recognized by exact files. */
export const executorAppSource = (
  origin: string,
  skills: readonly SourceFile[],
  document: HostedApiDocument,
) =>
  Effect.succeed({
    files: SourceFiles.make([
      { path: "index.ts", content: managementIndex(origin) },
      { path: "openapi.json", content: managementConfiguration(origin, document) },
      {
        path: "package.json",
        content: JSON.stringify(
          { name: "executor", private: true, type: "module", dependencies: {} },
          null,
          2,
        ),
      },
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
      ...skills.filter((file) => !file.path.startsWith("skills/")),
    ]),
  });

/** The default app accepts a saved user API key through the ordinary secrets method. */
export const defaultExecutorAppSource = (
  origin: string,
  skills: readonly SourceFile[],
  document: HostedApiDocument,
) =>
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
      ...skills.filter((file) => !file.path.startsWith("skills/")),
    ]),
  });
