/** Generate the ordinary local management app from the same OpenAPI document served to clients. */
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import { compileOpenApi } from "@executor-js/app-templates";
import { SourceFiles } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { localManagementDocument } from "../contracts/management.ts";

/** Source contains no credentials or configured port; the selected account supplies them at invocation. */
export const executorAppSource = () =>
  Effect.gen(function* () {
    const skills = yield* readExecutorSkills;
    return yield* compileOpenApi({ name: "Executor" }, localManagementDocument(), {
      baseUrl: "http://localhost",
    }).pipe(
      Effect.map((metadata) =>
        SourceFiles.make([
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
import { liveOpenapiOperations } from "apps/openapi";
import { wellKnownSkills } from "apps/skills";
import { executor } from "./provider.ts";
import configuration from "./openapi.json";
import { frameworkQueries } from "./framework.ts";
import reference from "./framework-reference.json";

export default defineApp({ accounts: { executor } }, async (context) => {
  const baseUrl = context.accounts.executor.fields.baseUrl;
  const operations = liveOpenapiOperations({
    ...configuration,
    source: { url: baseUrl + "/openapi.json" },
    baseUrl,
    allowedOrigin: new URL(baseUrl).origin,
    cache: context.cache,
    account: {
      method: context.accounts.executor.method,
      fields: { token: context.accounts.executor.fields.apiKey },
    },
    fetch: context.fetch,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const skills = await wellKnownSkills({ url: context.accounts.executor.fields.baseUrl + "/.well-known/agent-skills/index.json", fetch: context.fetch, signal: context.signal });
  return { ...operations, skills, queries: { ...operations.queries, ...frameworkQueries(reference) } };
});
`,
          },
          {
            path: "provider.ts",
            // Keep the existing provider definition and account slot so installs retain their connection.
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
            content: JSON.stringify({ ...metadata.configuration, source: undefined }, null, 2),
          },
          ...skills.filter((file) => !file.path.startsWith("skills/")),
        ]),
      ),
    );
  });
