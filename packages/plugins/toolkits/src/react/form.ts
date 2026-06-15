// ---------------------------------------------------------------------------
// Pure form <-> wire transforms for the toolkit editor. No React / DOM here so
// the bug-prone bits (the access-map ⇄ ToolkitConnectionEntry round-trip, scope
// tiering, slug derivation) are unit-testable in isolation.
// ---------------------------------------------------------------------------

import { IntegrationSlug } from "@executor-js/sdk/shared";

import type { ToolkitAccess, ToolkitConnectionEntry, ToolkitScope, ToolkitView } from "../shared";

/** A structural view of a core connection row — the fields the editor reads. */
export interface FormConn {
  readonly owner: "org" | "user";
  readonly name: string;
  readonly integration: string;
  readonly identityLabel?: string | null;
  readonly description?: string | null;
}

export interface AccessTier {
  readonly label: string;
  readonly conns: ReadonlyArray<FormConn>;
}

/** Stable key for the per-connection access/notes maps. A space can't appear in
 *  an integration slug, so `"<integration> <connection>"` is unambiguous. */
export const connKey = (integration: string, connection: string): string =>
  `${integration} ${connection}`;

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** A slug not already in `taken`; appends `-2`, `-3`, … on collision. */
export const uniqueSlug = (base: string, taken: ReadonlySet<string>): string => {
  const root = base || "toolkit";
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}-${i}`)) i += 1;
  return `${root}-${i}`;
};

/** Which connections a toolkit may draw on: workspace = org-owned only; personal
 *  = org + the caller's own, split into two tiers. */
export const tiersForScope = (
  connections: ReadonlyArray<FormConn>,
  scope: ToolkitScope,
): ReadonlyArray<AccessTier> => {
  const org = connections.filter((c) => c.owner === "org");
  if (scope === "workspace") return [{ label: "Workspace connections", conns: org }];
  const user = connections.filter((c) => c.owner === "user");
  return [
    { label: "Workspace connections", conns: org },
    { label: "Personal connections", conns: user },
  ];
};

/** Seed the editor's access + notes maps from an existing toolkit. */
export const accessFromToolkit = (
  toolkit: ToolkitView | null,
): { access: Record<string, ToolkitAccess>; notes: Record<string, string> } => {
  const access: Record<string, ToolkitAccess> = {};
  const notes: Record<string, string> = {};
  for (const e of toolkit?.connections ?? []) {
    const key = connKey(e.integration, e.connection);
    access[key] = e.access;
    if (e.note) notes[key] = e.note;
  }
  return { access, notes };
};

/** Collapse the editor's access + notes maps back into the wire entries —
 *  only connections set to read/full (off = absent), notes trimmed. */
export const entriesFromAccess = (
  connections: ReadonlyArray<FormConn>,
  scope: ToolkitScope,
  access: Readonly<Record<string, ToolkitAccess>>,
  notes: Readonly<Record<string, string>>,
): ReadonlyArray<ToolkitConnectionEntry> => {
  const entries: Array<ToolkitConnectionEntry> = [];
  for (const tier of tiersForScope(connections, scope)) {
    for (const c of tier.conns) {
      const key = connKey(c.integration, c.name);
      const a = access[key] ?? "off";
      if (a === "off") continue;
      const note = notes[key]?.trim();
      entries.push({
        integration: IntegrationSlug.make(c.integration),
        connection: c.name,
        access: a,
        ...(note ? { note } : {}),
      });
    }
  }
  return entries;
};
