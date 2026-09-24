import { SourceFiles, type SourceFile } from "@executor-js/sdk/core";
import { Effect } from "effect";
/** Executor uses the same source generator, provider accounts and deployments as other API apps. */
import { CatalogEntry } from "@executor-js/catalog/contracts";
import { compileOpenApi, generateOpenApiApp } from "@executor-js/app-templates";
import type { HostedApiDocument } from "../contracts/api.ts";

/** This installation's public API, available as an ordinary OpenAPI app. */
export const executorCatalogEntry = (origin: string) =>
  CatalogEntry.make({
    id: `${origin}/openapi.json`,
    kind: "openapi",
    name: "Executor",
    description: "Manage apps and connected accounts in Executor.",
    domain: new URL(origin).hostname,
    connectUrl: `${origin}/openapi.json`,
    oauthDiscoveryUrl: `${origin}/api`,
    feeds: ["curated"],
  });

/** The catalog retains the ordinary OAuth connection for explicitly installed copies. */
const managementIndex = (origin: string, apiKey = false) => `import { defineApp } from "apps";
import { openapiOperations } from "apps/openapi";
import { wellKnownSkills } from "apps/skills";
import { provider } from "./provider.ts";
import metadata from "./operations.json";
import { frameworkQueries } from "./framework.ts";
import reference from "./framework-reference.json";

export default defineApp({ accounts: { service: provider } }, async (context) => {
  const account = context.accounts.service;
  const operations = await openapiOperations({
    ...metadata,
    ${
      apiKey
        ? `account: account.method === "apiKey"
      ? { ...account, method: "oauth", fields: { access_token: account.fields.token } }
      : account,
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (account.method === "apiKey") request.headers.set("X-Executor-Organization", account.fields.organization);
      return context.fetch(request);
    },`
        : `account,
    fetch: context.fetch,`
    }
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const skills = await wellKnownSkills({ url: ${JSON.stringify(`${origin}/.well-known/agent-skills/index.json`)}, fetch: context.fetch, signal: context.signal });
  return { ...operations, skills, queries: { ...operations.queries, ...frameworkQueries(reference) } };
});
`;

export const executorAppSource = (
  origin: string,
  skills: readonly SourceFile[],
  document: HostedApiDocument,
) =>
  generateOpenApiApp(executorCatalogEntry(origin), document, { baseUrl: origin }).pipe(
    Effect.map((generated) => ({
      toolCount: generated.toolCount + 2,
      files: SourceFiles.make([
        { path: "index.ts", content: managementIndex(origin) },
        ...generated.files.filter(
          (file) => file.path !== "index.ts" && file.path !== "operations.json",
        ),
        { path: "operations.json", content: JSON.stringify(generated.metadata) },
        ...skills.filter((file) => !file.path.startsWith("skills/")),
      ]),
    })),
  );

/** The default app accepts a saved user API key through the ordinary secrets method. */
export const defaultExecutorAppSource = (
  origin: string,
  skills: readonly SourceFile[],
  document: HostedApiDocument,
) =>
  compileOpenApi(executorCatalogEntry(origin), document, { baseUrl: origin }).pipe(
    Effect.map((metadata) => ({
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
        {
          path: "operations.json",
          content: JSON.stringify(metadata, null, 2),
        },
        ...skills.filter((file) => !file.path.startsWith("skills/")),
      ]),
    })),
  );
