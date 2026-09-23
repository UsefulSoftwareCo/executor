/**
 * One-tool app sketch, self-contained because the playground deploys only
 * this file. The app host is not implemented yet.
 */
import { query, array, decodeJson, defineApp, defineProvider, object, secrets, string } from "apps";

/** Vercel with a single named method: a personal API token. */
export const vercel = defineProvider({
  name: "Vercel",
  auth: {
    apiKey: secrets({
      label: "API token",
      fields: object({ token: string() }),
    }),
  },
});

const ProjectList = object({
  projects: array(object({ id: string(), name: string() })),
});

const accounts = { vercel };

/**
 * Static declaration; the host supplies the bound Vercel account per invocation.
 * HTTP work happens only when listProjects runs, using native fetch and the
 * supplied token; the host owns that credential and supplies it per call.
 */
export default defineApp(
  { accounts },
  {
    queries: {
      listProjects: query(
        { description: "List the account's Vercel projects.", input: object({}) },
        async ({ accounts, fetch }) => {
          const response = await fetch("https://api.vercel.com/v9/projects?limit=10", {
            headers: { Authorization: `Bearer ${accounts.vercel.fields.token}` },
          });
          return decodeJson(response, ProjectList);
        },
      ),
    },
  },
);
