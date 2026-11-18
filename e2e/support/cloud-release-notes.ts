/**
 * The notes every scenario's local Cloud builds its dashboard with, as its notes input
 * (`EXECUTOR_CLOUD_RELEASE_NOTES`, read by apps/hosted/cloud/web/release-notes.ts), newest first as
 * `scripts/releases/release-notes.ts --cloud` writes them. The newest is a line the release notes'
 * allow-list refuses, which the dashboard must leave out whatever its build holds. The oldest is
 * more than 30 days before the day the scenario sets the browser's clock to: the build's notes are
 * all shown whatever that clock says, since a deploy writes only the 30 days before its commit.
 */
export const cloudTestNotes = {
  notes: [
    { date: "2026-11-14", text: "<b>Refused</b> by the allow-list." },
    { date: "2026-11-14", text: "Apps open from the sidebar in one click." },
    { date: "2026-11-14", text: "The apps page loads faster for large teams." },
    { date: "2026-11-12", text: "Search finds apps by the tools they offer." },
    { date: "2026-11-03", text: "Members can leave an organization themselves." },
  ],
} as const;

/**
 * The notes file a deploy writes when no change in its window has a note: it holds none. The local
 * Cloud of `e2e:cloud --empty-release-notes` builds its dashboard with it.
 */
export const emptyCloudNotes = { notes: [] } as const;
