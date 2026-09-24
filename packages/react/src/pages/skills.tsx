import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { Owner } from "@executor-js/sdk/shared";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { skillsOptimisticAtom } from "../api/atoms";
import { useOrganizationId } from "../api/organization-context";
import { Button } from "../components/button";
import { ErrorState } from "../components/error-state";
import { PageContainer, PageHeader } from "../components/page";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { connectionOwnerOptionsForHost } from "../plugins/connection-owner";

export function useSkillOwnerLabel(): (owner: Owner) => string {
  const options = connectionOwnerOptionsForHost(useOrganizationId());
  return (owner) =>
    options.find((option) => option.owner === owner)?.label ??
    (owner === "org" ? "Workspace" : "Personal");
}

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
    <p className="text-sm text-muted-foreground">Loading skills...</p>
  </div>
);

const EmptyState = () => (
  <div className="rounded-lg border border-dashed border-border px-6 py-16 text-center">
    <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
      No managed skills yet. Add a SKILL.md package to make its instructions available to agents
      through Executor.
    </p>
  </div>
);

function deliveryLabel(delivery: {
  readonly kind: "blocked" | "disabled" | "enabled";
  readonly invocation?: "manual" | "model";
}): string {
  if (delivery.kind === "blocked") return "Blocked";
  if (delivery.kind === "disabled") return "Disabled";
  return delivery.invocation === "model" ? "Model can invoke" : "Manual only";
}

function SkillRow(props: {
  readonly skill: {
    readonly id: string;
    readonly owner: Owner;
    readonly name: string | null;
    readonly description: string | null;
    readonly delivery: {
      readonly kind: "blocked" | "disabled" | "enabled";
      readonly invocation?: "manual" | "model";
    };
    readonly updatedAt: number;
  };
}) {
  const { skill } = props;
  return (
    <li className="group/skill-row relative isolate flex items-start justify-between gap-4 px-4 py-3.5 transition-colors duration-150 focus-within:bg-accent/40 hover:bg-accent/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-mono text-sm text-foreground">
            <Link
              to="/{-$orgSlug}/skills/$skillId"
              params={{ skillId: skill.id }}
              className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
            >
              {skill.name ?? "Invalid skill package"}
            </Link>
          </h3>
          <SkillOwnerTag owner={skill.owner} />
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {deliveryLabel(skill.delivery)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {skill.description ?? "This package needs repair before agents can use it."}
        </p>
      </div>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {formatRelativeTime(skill.updatedAt)}
      </span>
    </li>
  );
}

export function SkillsPage() {
  useExecutorDocumentTitle("Skills");
  const skills = useAtomValue(skillsOptimisticAtom);
  const refresh = useAtomRefresh(skillsOptimisticAtom);

  return (
    <PageContainer>
      <PageHeader
        title="Skills"
        description="Manage the Agent Skills packages Executor delivers to connected agents."
        actions={
          <Button asChild size="sm">
            <Link to="/{-$orgSlug}/skills/new">Add skill</Link>
          </Button>
        }
      />
      {isAsyncResultLoading(skills) ? (
        <LoadingState />
      ) : (
        AsyncResult.match(skills, {
          onInitial: () => <LoadingState />,
          onFailure: () => <ErrorState message="Failed to load skills" onRetry={refresh} />,
          onSuccess: ({ value }) => {
            const rows = [...value].sort((left, right) => {
              if (left.owner !== right.owner) return left.owner === "org" ? -1 : 1;
              return (left.name ?? "").localeCompare(right.name ?? "");
            });
            return rows.length === 0 ? (
              <EmptyState />
            ) : (
              <section>
                <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Managed skills{" "}
                  <span className="ml-2 font-normal tabular-nums">{rows.length}</span>
                </h2>
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                  {rows.map((skill) => (
                    <SkillRow key={skill.id} skill={skill} />
                  ))}
                </ul>
              </section>
            );
          },
        })
      )}
    </PageContainer>
  );
}
