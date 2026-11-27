import { packageFile } from "@executor-js/app-templates";
import { SourceFiles } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { localManagementDocument } from "../contracts/management.ts";

export const executorAppSource = () =>
  Effect.sync(() => {
    const document = localManagementDocument();
    const configuration = {
      source: { document },
      allowedOrigin: "http://localhost",
      securitySchemes: document.components.securitySchemes,
      methods: { apiKey: [{ scheme: "apiKey", field: "token", part: "value", prefix: "" }] },
      oauth: [],
      baseUrl: "http://localhost",
    };
    return SourceFiles.make([
      {
        path: "index.ts",
        content: `import { defineApp, dynamicSkills } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import { wellKnownSkills } from "apps/skills";
import { executor } from "./provider.ts";
import configuration from "./openapi.json";

export default defineApp({ user: { accounts: { executor } } }, async (context) => {
  const baseUrl = context.user.accounts.executor.fields.baseUrl;
  const tools = liveOpenapiRouter({
    ...configuration,
    baseUrl,
    allowedOrigin: new URL(baseUrl).origin,
    cache: context.cache,
    account: {
      method: context.user.accounts.executor.method,
      fields: { token: context.user.accounts.executor.fields.apiKey },
    },
    fetch: context.fetch,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const skills = dynamicSkills({ list: () => wellKnownSkills({ url: baseUrl + "/.well-known/agent-skills/index.json", cache: context.cache, fetch: context.fetch, signal: context.signal }) });
  return { tools, dynamicSkills: skills };
});
`,
      },
      {
        path: "provider.ts",
        content: `import { defineProvider, object, secrets, string } from "apps";

export const executor = defineProvider({
  name: "Executor",
  auth: {
    apiKey: secrets({ label: "API key", fields: object({ baseUrl: string(), apiKey: string() }) }),
  },
});
`,
      },
      {
        path: "openapi.json",
        content: JSON.stringify(configuration, null, 2),
      },
      packageFile("executor"),
    ]);
  });
