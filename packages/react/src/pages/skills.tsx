import { useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Owner } from "@executor-js/sdk/shared";

import { skillsAtom } from "../api/atoms";
import { useOrganizationId } from "../api/organization-context";
import { Button } from "../components/button";
import { ErrorState } from "../components/error-state";
import { PageContainer, PageHeader } from "../components/page";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { connectionOwnerOptionsForHost } from "../plugins/connection-owner";
import { SkillImportDialog } from "./skill-import-dialog";

/** The wire row `skills.list` returns — the manifest, without file contents. */
interface SkillSummaryRow {
  readonly owner: Owner;
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
  readonly updatedAt: number;
}

/**
 * Personal / Workspace / Local, in the host's own words.
 *
 * A skill is owner-scoped exactly like a connection, so it says "Workspace"
 * where connections say "Workspace" and "Local" on a host that has one bucket —
 * two vocabularies for the same `Owner` would be a lie about what it means.
 */
export function useSkillOwnerLabel(): (owner: Owner) => string {
  const options = connectionOwnerOptionsForHost(useOrganizationId());
  return (owner) =>
    options.find((option) => option.owner === owner)?.label ??
    (owner === "org" ? "Workspace" : "Personal");
}

/** The owner badge: a mono chip, since the owner is metadata about the skill. */
export function SkillOwnerTag(props: { readonly owner: Owner }) {
  const label = useSkillOwnerLabel();
  return (
    <span className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {label(props.owner)}
    </span>
  );
}

const LoadingState = () => (
  <div className="flex items-center gap-2 py-8">
    <div className="size-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
    <p className="text-sm text-muted-foreground">Loading skills…</p>
  </div>
);

/** Skills are the one workspace resource a PERSON authors, so the empty state
 *  says what one is and what adding it does, then points at the button. */
const EmptyState = () => (
  <div
    data-slot="skill-empty"
    className="rounded-lg border border-dashed border-border px-6 py-16 text-center"
  >
    <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
      No skills yet. A skill is a SKILL.md file — instructions an agent loads on demand, plus any
      files it references. Add one and every agent connected to this workspace can find it by name.
    </p>
  </div>
);

function SkillRow(props: { readonly skill: SkillSummaryRow }) {
  const { skill } = props;
  return (
    <li className="group/skill-row relative isolate flex items-start justify-between gap-4 px-4 py-3.5 transition-colors duration-150 focus-within:bg-accent/40 hover:bg-accent/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* The whole row is the target; the link overlays it so the row keeps
              one accessible name and one focus stop. */}
          <h3 className="truncate font-mono text-sm text-foreground">
            <Link
              to="/{-$orgSlug}/skills/$skillOwner/$skillName"
              params={{ skillOwner: skill.owner, skillName: skill.name }}
              className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
            >
              {skill.name}
            </Link>
          </h3>
          <SkillOwnerTag owner={skill.owner} />
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {skill.description}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 font-mono text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {skill.files.length} {skill.files.length === 1 ? "file" : "files"}
        </span>
        <span>{formatRelativeTime(skill.updatedAt)}</span>
      </div>
    </li>
  );
}

export function SkillsPage() {
  useExecutorDocumentTitle("Skills");
  const skills = useAtomValue(skillsAtom);
  const refresh = useAtomRefresh(skillsAtom);
  const [importing, setImporting] = useState(false);

  return (
    <PageContainer>
      <PageHeader
        title="Skills"
        description="SKILL.md instructions your agents can load on demand. Save one here and every agent connected to this workspace discovers it — personally, or shared with everyone."
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setImporting(true)}>
              Import from GitHub
            </Button>
            <Button asChild size="sm">
              <Link to="/{-$orgSlug}/skills/new">Add Skill</Link>
            </Button>
          </div>
        }
      />
      {importing ? (
        <SkillImportDialog
          onClose={() => setImporting(false)}
          onImported={(saved) => {
            refresh();
            toast.success(
              saved.length === 1
                ? `Imported ${saved[0]?.name ?? "skill"}`
                : `Imported ${saved.length} skills`,
            );
          }}
        />
      ) : null}

      {isAsyncResultLoading(skills) ? (
        <LoadingState />
      ) : (
        AsyncResult.match(skills, {
          onInitial: () => <LoadingState />,
          onFailure: () => <ErrorState message="Failed to load skills" onRetry={refresh} />,
          onSuccess: ({ value }) => {
            // Workspace skills first, then by name: the shared set is the one a
            // reader is checking against, and name order makes it scannable.
            const rows = [...value].sort((a, b) =>
              a.owner === b.owner ? a.name.localeCompare(b.name) : a.owner === "org" ? -1 : 1,
            );
            return (
              <section>
                <h2 className="mb-3 flex items-center font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Saved skills
                  {rows.length > 0 ? (
                    <span className="ml-2 font-normal tabular-nums">{rows.length}</span>
                  ) : null}
                </h2>
                {rows.length === 0 ? (
                  <EmptyState />
                ) : (
                  <ul
                    data-slot="skill-list"
                    className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
                  >
                    {rows.map((skill) => (
                      <SkillRow key={`${skill.owner}/${skill.name}`} skill={skill} />
                    ))}
                  </ul>
                )}
              </section>
            );
          },
        })
      )}
    </PageContainer>
  );
}
