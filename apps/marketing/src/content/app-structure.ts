/** A small GitHub briefing app, shown as source in the homepage file viewer. */
export const appFiles = [
  {
    path: "index.ts",
    label: "The entry point",
    description: "Brings the accounts, data, tools, and workflows together in one app.",
    language: "ts",
    source: `import { defineApp } from "apps";
import { github } from "./providers";
import { database } from "./database";
import { listBriefs, saveBrief, refreshBrief } from "./tools";
import { refresh } from "./workflows";

export const requirements = {
  accounts: { github },
  database,
};

export default defineApp(requirements, {
  queries: { listBriefs },
  mutations: { saveBrief, refreshBrief },
  workflows: { refresh },
});`,
  },
  {
    path: "tools.ts",
    label: "Tools for your agent",
    description:
      "Ordinary functions to read, save, and refresh a brief. Your agent can call them as tools.",
    language: "ts",
    source: `import { query, mutation, object, string, array } from "apps";
import type { QueryContext, MutationContext } from "apps";
import type { requirements } from "./index";
import { Brief, BriefInput } from "./database";

type Read = QueryContext<typeof requirements>;
type Write = MutationContext<typeof requirements>;

export const Repository = object({
  owner: string(),
  name: string(),
});

export const listBriefs = query(
  { input: object({}), output: array(Brief) },
  async ({ db }: Read) =>
    db.briefs.withIndex("by_creation").order("desc").take(10),
);

export const saveBrief = mutation(
  { input: BriefInput, output: Brief },
  async ({ db }: Write, input) => db.briefs.insert(input),
);

export const refreshBrief = mutation(
  { input: Repository },
  async (ctx: Write, input) =>
    ctx.workflows.start({ workflow: "refresh", input }),
);`,
  },
  {
    path: "providers.ts",
    label: "Connected accounts",
    description:
      "Declares the service this app uses. Executor handles sign-in and keeps credentials out of these files.",
    language: "ts",
    source: `import { defineProvider, oauth2 } from "apps";

export const github = defineProvider({
  name: "GitHub",
  auth: {
    oauth: oauth2({
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo"],
    }),
  },
});`,
  },
  {
    path: "database.ts",
    label: "Data that stays",
    description:
      "Defines the records your app saves. Briefs stay available between runs and appear in the UI.",
    language: "ts",
    source: `import { defineDatabase, table, object, string, number } from "apps";

const fields = {
  repository: string(),
  openIssues: number(),
};

export const BriefInput = object(fields);
export const Brief = object({ id: string(), ...fields });

export const database = defineDatabase({
  briefs: table(fields),
});`,
  },
  {
    path: "workflows.ts",
    label: "Work in the background",
    description:
      "Reads from GitHub, then saves the result. Executor tracks each step so work can resume after an interruption.",
    language: "ts",
    source: `import { workflow, object, number } from "apps";
import type { WorkflowContext } from "apps";
import type { requirements } from "./index";
import { Repository, saveBrief } from "./tools";

type Context = WorkflowContext<typeof requirements>;
const Stats = object({ open_issues_count: number() });

export const refresh = workflow(
  { input: Repository },
  async (ctx: Context, { owner, name }) => {
    const repository = owner + "/" + name;
    const openIssues = await ctx.step.do("Read GitHub", async (step) => {
      const path = encodeURIComponent(owner) + "/" + encodeURIComponent(name);
      const response = await step.fetch("https://api.github.com/repos/" + path, {
        headers: {
          Authorization: "Bearer " + step.accounts.github.fields.access_token,
          "User-Agent": "Daily brief",
        },
      });
      if (!response.ok) throw new Error("Could not read the repository");
      return Stats.parse(await response.json()).open_issues_count;
    });

    return ctx.step.runMutation("Save the brief", saveBrief, {
      repository,
      openIssues,
    });
  },
);`,
  },
  {
    path: "skills/brief/SKILL.md",
    label: "Instructions your agent can follow",
    description:
      "A Markdown file teaches your agent when to use the app and how to work with its tools.",
    language: "md",
    source: `---
name: brief
description: Review recent GitHub activity with Daily brief.
---

# Give me a project brief

1. Ask which repository to review if it is not clear.
2. Use refreshBrief with the repository owner and name.
3. Wait for the workflow to finish, then call listBriefs.
4. Summarize the saved open issue count in plain language.

Mention which repository the brief covers.
If the refresh fails, say so instead of presenting old data as new.

Follow the user's instructions and Executor's approval requests.`,
  },
  {
    path: "ui/main.tsx",
    label: "An interface for you",
    description:
      "A React page that reads the same data as your agent. Executor gives it its own URL.",
    language: "tsx",
    source: `import { createRoot } from "react-dom/client";
import { array } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { listBriefs } from "../tools";
import { Brief } from "../database";

const client = createAppClient();
const briefs = client.queryAtom(
  queryReference<typeof listBriefs>("listBriefs"),
  {},
  array(Brief),
);

function DailyBrief() {
  const { data, pending, error } = useAppQuery(briefs);
  if (pending) return <p>Loading your briefs…</p>;
  if (error) return <p>Could not load your briefs.</p>;

  return (
    <main>
      <h1>Your project briefs</h1>
      {data?.map((brief) => (
        <article key={brief.id}>
          <h2>{brief.repository}</h2>
          <p>{brief.openIssues} open issues</p>
        </article>
      ))}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(<DailyBrief />);`,
  },
  {
    path: "ui/index.html",
    label: "The page shell",
    description: "A normal HTML document loads your app's interface.",
    language: "html",
    source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daily brief</title>
    <script type="module" src="./main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
  },
  {
    path: "package.json",
    label: "Use the libraries you know",
    description: "Add packages from npm when you need them. This app uses React for its interface.",
    language: "json",
    source: `{
  "name": "daily-brief",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^19.2.5",
    "react-dom": "^19.2.5"
  }
}`,
  },
] as const;

/** Copy shared by the homepage and its Markdown representation. */
export const appStructure = {
  title: "It's just code",
  subtitle: "And you don't have to write it",
  files: appFiles,
  note: "One file is enough to start. Add the rest when you need them.",
  caption: "Your agent writes and updates the files. Executor builds and runs the app.",
} as const;
