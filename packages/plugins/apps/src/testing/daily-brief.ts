// ---------------------------------------------------------------------------
// The daily-brief fixture set, as an in-memory file set (path -> contents).
//
// Adapted from prototypes/executor-artifacts to be executable against the
// implemented contract: `tools/issues-sync.ts` writes the scope `issues` table,
// `workflows/morning-sync.ts` schedules it and flags stale issues,
// `ui/dashboard.tsx` reads the table, `skills/issues-brief/SKILL.md` routes the
// agent. These are payloads (author code), not package source, so they live as
// strings rather than compiled files.
// ---------------------------------------------------------------------------

export const DAILY_BRIEF_MANIFEST = `{
  "$schema": "https://executor.sh/schemas/scope-manifest.json",
  "scope": "rhys",
  "description": "Personal scope artifacts — GitHub issues brief.",
  "connections": { "github": "github/rhys" },
  "artifacts": { "skills": "skills/", "tools": "tools/", "workflows": "workflows/", "ui": "ui/" }
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
    since: z.string().optional().describe("ISO timestamp — only issues updated after this"),
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

export const MORNING_SYNC_TS = `import { defineWorkflow } from "executor:app";

export default defineWorkflow({
  description: "Refresh GitHub issues at 9am and flag stale ones.",
  schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" },
  async run(step, { db }) {
    const { synced } = await step.tool("issues-sync", {});
    const stale = await step.do("find-stale", () =>
      db.sql\`
        SELECT repo, number, title FROM issues
        WHERE updated_at < datetime('now', '-14 days')
        ORDER BY updated_at ASC\`,
    );
    if (stale.length > 0) {
      await step.notify({
        title: \`\${stale.length} issues stale >14 days\`,
        body: stale.slice(0, 5).map((i) => \`\${i.repo}#\${i.number} — \${i.title}\`).join("\\n"),
        link: "ui://dashboard",
      });
    }
    return { synced, stale: stale.length };
  },
});
`;

export const DASHBOARD_TSX = `import { useQuery, useTool, config } from "executor:ui";
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Input } from "executor:ui/components";
import { useState } from "react";

config({ maxHeight: 720, title: "GitHub Issues" });

export default function App() {
  const [filter, setFilter] = useState("");
  const issues = useQuery((db) => db.sql\`SELECT * FROM issues ORDER BY updated_at DESC\`);
  const sync = useTool("issues-sync");
  if (issues.isLoading) return <Card><CardContent>Loading issues…</CardContent></Card>;
  const rows = issues.data.filter(
    (i) => !filter || i.repo.includes(filter) || i.title.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-4 p-1">
      <div className="flex items-center gap-2">
        <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button disabled={sync.isRunning} onClick={() => sync.run({}).then(() => issues.refetch())}>
          {sync.isRunning ? "Syncing…" : "Sync now"}
        </Button>
        <span className="ml-auto">{rows.length} open issues</span>
      </div>
      <Card>
        <CardHeader><CardTitle>Open issues</CardTitle></CardHeader>
        <CardContent>
          {rows.slice(0, 30).map((issue) => (
            <a key={\`\${issue.repo}#\${issue.number}\`} href={issue.url}>
              <span>{issue.repo}#{issue.number}</span> <span>{issue.title}</span>
              {JSON.parse(issue.labels).map((l) => (<Badge key={l}>{l}</Badge>))}
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
`;

export const ISSUES_BRIEF_SKILL = `---
name: issues-brief
description: Answer questions about open GitHub issues from the scope \`issues\` database instead of paging the GitHub API; sync first if stale. Use when the user asks about their issues, the issue backlog, stale issues, or anything GitHub-issue related.
---

# GitHub issues brief

The scope database has an \`issues\` table maintained by the \`issues-sync\`
tool and refreshed weekday mornings by the \`morning-sync\` workflow. Answer
issue questions from this table — do not page the GitHub API directly.

## Recipe

1. Check freshness: \`SELECT MAX(updated_at) FROM issues\`. If older than ~24h, call \`issues-sync\` first.
2. Query the table for what was asked.
3. For anything visual, open the authored dashboard: \`ui://dashboard\`.
`;

/** The daily-brief file set as a path -> contents map. */
export const dailyBriefFileSet = (): Map<string, string> =>
  new Map<string, string>([
    ["executor.json", DAILY_BRIEF_MANIFEST],
    ["tools/issues-sync.ts", ISSUES_SYNC_TS],
    ["tools/search-all-mail.ts", SEARCH_ALL_MAIL_TS],
    ["workflows/morning-sync.ts", MORNING_SYNC_TS],
    ["ui/dashboard.tsx", DASHBOARD_TSX],
    ["skills/issues-brief/SKILL.md", ISSUES_BRIEF_SKILL],
  ]);
