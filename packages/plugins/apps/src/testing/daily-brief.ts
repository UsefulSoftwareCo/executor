export const DAILY_BRIEF_MANIFEST = `{
  "$schema": "https://executor.sh/schemas/scope-manifest.json",
  "scope": "rhys",
  "description": "Personal scope artifacts, GitHub issues brief.",
  "connections": { "github": "github/rhys" },
  "artifacts": { "tools": "tools/" }
}
`;

export const ISSUES_SYNC_TS = `import { z } from "zod";
import { defineTool, connection } from "executor:app";

export default defineTool({
  description:
    "Refresh the scope \\\`issues\\\` table from GitHub. Syncs open issues across the given repos (default: every repo the connection can see).",
  connections: {
    github: connection("github", { description: "GitHub account whose issues to sync" }),
  },
  input: z.object({
    repos: z.array(z.string()).optional().describe("owner/repo entries; omit to sync all accessible repos"),
    since: z.string().optional().describe("ISO timestamp, only issues updated after this"),
  }),
  output: z.object({ synced: z.number(), repos: z.number() }),
  annotations: { readOnly: false, destructive: false },
  async handler({ repos, since }, { github, db }) {
    const targets =
      repos ??
      (await github.repos.listForAuthenticatedUser({ per_page: 100 })).map((r) => r.full_name);

    await db.sql\`
      CREATE TABLE IF NOT EXISTS issues (
        repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]', assignee TEXT, updated_at TEXT NOT NULL, url TEXT NOT NULL,
        PRIMARY KEY (repo, number)
      )\`;

    let synced = 0;
    for (const target of targets) {
      const [owner, repo] = target.split("/");
      const issues = await github.issues.listForRepo({ owner, repo, state: "open", since, per_page: 100 });
      for (const issue of issues) {
        if (issue.pull_request) continue;
        await db.sql\`
          INSERT INTO issues (repo, number, title, labels, assignee, updated_at, url)
          VALUES (\${target}, \${issue.number}, \${issue.title},
            \${JSON.stringify(issue.labels.map((l) => l.name))},
            \${issue.assignee?.login ?? null}, \${issue.updated_at}, \${issue.html_url})
          ON CONFLICT (repo, number) DO UPDATE SET
            title = excluded.title, labels = excluded.labels,
            assignee = excluded.assignee, updated_at = excluded.updated_at\`;
        synced++;
      }
    }
    return { synced, repos: targets.length };
  },
});
`;

export const SEARCH_ALL_MAIL_TS = `import { z } from "zod";
import { defineTool, connections } from "executor:app";

export default defineTool({
  description:
    "Search across all connected Gmail accounts. Returns matches newest-first, tagged with which inbox they came from.",
  connections: {
    inboxes: connections("gmail", { description: "Gmail accounts to search across" }),
  },
  input: z.object({
    query: z.string().describe("Gmail search syntax, e.g. from:acme subject:invoice"),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: z.object({
    results: z.array(z.object({
      inbox: z.string(), id: z.string(), from: z.string(),
      subject: z.string(), snippet: z.string(), date: z.string(),
    })),
  }),
  annotations: { readOnly: true },
  async handler({ query, limit }, { inboxes }) {
    const perInbox = await Promise.all(
      inboxes.map(async (inbox) => {
        const { messages } = await inbox.messages.search({ q: query, maxResults: limit });
        return messages.map((m) => ({
          inbox: inbox.account.email, id: m.id, from: m.from,
          subject: m.subject, snippet: m.snippet, date: m.date,
        }));
      }),
    );
    const results = perInbox.flat().sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
    return { results };
  },
});
`;

export const dailyBriefFileSet = (): Map<string, string> =>
  new Map<string, string>([
    ["executor.json", DAILY_BRIEF_MANIFEST],
    ["tools/issues-sync.ts", ISSUES_SYNC_TS],
    ["tools/search-all-mail.ts", SEARCH_ALL_MAIL_TS],
  ]);
