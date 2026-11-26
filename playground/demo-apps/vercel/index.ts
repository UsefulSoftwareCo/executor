import {
  query,
  array,
  decodeJson,
  defineApp,
  defineProvider,
  object,
  secrets,
  string,
  router,
} from "apps";

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

export default defineApp(
  { user: { accounts } },
  {
    tools: router({
      listProjects: query(
        { description: "List the account's Vercel projects.", input: object({}) },
        async ({ user: { accounts }, fetch }) => {
          const response = await fetch("https://api.vercel.com/v9/projects?limit=10", {
            headers: { Authorization: `Bearer ${accounts.vercel.fields.token}` },
          });
          return decodeJson(response, ProjectList);
        },
      ),
    }),
  },
);
