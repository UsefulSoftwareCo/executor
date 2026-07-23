export type ChangelogEntry = {
  body: string;
  prNumber?: number;
  prUrl?: string;
};

export type ChangelogRelease = {
  version: string;
  entries: ChangelogEntry[];
};

const releaseHeading = /^##\s+(.+?)\s*$/;
const changesHeading = /^###\s+(Major|Minor|Patch) Changes\s*$/;
const anyHeading = /^#{1,6}\s+/;
const listItem = /^-\s+(.*)$/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let inChanges = false;
  let pendingItem: string[] | null = null;

  const flushItem = () => {
    if (!current || !pendingItem) {
      pendingItem = null;
      return;
    }

    const entry = parseItem(pendingItem);
    if (entry) current.entries.push(entry);
    pendingItem = null;
  };

  const flushRelease = () => {
    flushItem();
    if (current && current.entries.length > 0) releases.push(current);
  };

  for (const line of lines) {
    const release = releaseHeading.exec(line);
    if (release) {
      flushRelease();
      current = { version: release[1] ?? "", entries: [] };
      inChanges = false;
      continue;
    }

    if (!current) continue;

    if (changesHeading.test(line)) {
      flushItem();
      inChanges = true;
      continue;
    }

    if (anyHeading.test(line)) {
      flushItem();
      inChanges = false;
      continue;
    }

    if (!inChanges) continue;

    const item = listItem.exec(line);
    if (item) {
      flushItem();
      pendingItem = [item[1] ?? ""];
      continue;
    }

    if (pendingItem) pendingItem.push(line);
  }

  flushRelease();
  return releases;
}

function parseItem(lines: string[]): ChangelogEntry | null {
  const firstLine = lines[0]?.trimStart() ?? "";
  if (firstLine.startsWith("Updated dependencies")) return null;

  const normalized = [
    firstLine,
    ...lines.slice(1).map((line) => (line.startsWith("  ") ? line.slice(2) : line)),
  ];
  const prMatch = /^\[#(\d+)\]\(([^)]+)\)\s+/.exec(normalized[0] ?? "");
  const entry: ChangelogEntry = { body: "" };
  let body = normalized.join("\n").trim();

  if (prMatch?.[1] && prMatch[2]) {
    entry.prNumber = Number.parseInt(prMatch[1], 10);
    entry.prUrl = prMatch[2];
    body = body.slice(prMatch[0].length).trimStart();
  }

  body = body
    .replace(/^\[`[0-9a-f]{7,40}`\]\([^)]+\)\s+/, "")
    .replace(/^Thanks \[@[^\]]+\]\([^)]+\)! -\s*/, "")
    .trim();

  if (!body) return null;
  return { ...entry, body };
}
