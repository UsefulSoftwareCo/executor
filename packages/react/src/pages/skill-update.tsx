import { useState } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ManagedSkillId, SkillCandidateId } from "@executor-js/sdk/shared";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { toast } from "sonner";

import { applySkillUpdate, skillAtom, skillUpdateReviewAtom } from "../api/atoms";
import { skillWriteKeys } from "../api/reactivity-keys";
import { Button } from "../components/button";
import { ErrorState } from "../components/error-state";
import { PageContainer, PageHeader } from "../components/page";
import { useExecutorDocumentTitle } from "../lib/document-title";

export function SkillUpdatePage(props: {
  readonly skillId: ManagedSkillId;
  readonly candidateId: SkillCandidateId;
}) {
  useExecutorDocumentTitle("Review skill update");
  const skill = useAtomValue(skillAtom(props.skillId));
  const review = useAtomValue(
    skillUpdateReviewAtom({ skillId: props.skillId, candidateId: props.candidateId }),
  );
  const refreshReview = useAtomRefresh(
    skillUpdateReviewAtom({ skillId: props.skillId, candidateId: props.candidateId }),
  );
  const apply = useAtomSet(applySkillUpdate, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [resolutions, setResolutions] = useState<Readonly<Record<string, "local" | "upstream">>>(
    {},
  );
  const [applying, setApplying] = useState(false);

  if (!AsyncResult.isSuccess(skill) || !AsyncResult.isSuccess(review)) {
    if (AsyncResult.isFailure(skill) || AsyncResult.isFailure(review)) {
      return (
        <PageContainer>
          <ErrorState
            message="This update review is unavailable or expired."
            onRetry={refreshReview}
          />
        </PageContainer>
      );
    }
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Loading update review...</p>
      </PageContainer>
    );
  }

  const unresolved = review.value.conflicts.filter((path) => resolutions[path] === undefined);
  const applyUpdate = async () => {
    if (unresolved.length > 0) return;
    setApplying(true);
    const exit = await apply({
      params: { skillId: props.skillId, candidateId: props.candidateId },
      payload: {
        expectedActiveRevisionId: review.value.expectedActiveRevisionId,
        expectedBaselineRevisionId: review.value.expectedBaselineRevisionId,
        resolutions: review.value.conflicts.map((path) => ({
          path,
          choice: resolutions[path] ?? "local",
        })),
      },
      reactivityKeys: skillWriteKeys,
    });
    setApplying(false);
    if (Exit.isFailure(exit)) {
      toast.error("The skill changed after this review opened. Check again.");
      return;
    }
    toast.success("Skill update applied");
    await navigate({
      to: "/{-$orgSlug}/skills/$skillId",
      params: { skillId: props.skillId },
    });
  };

  return (
    <PageContainer>
      <div className="mb-4">
        <Link
          to="/{-$orgSlug}/skills/$skillId"
          params={{ skillId: props.skillId }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {skill.value.name ?? "Skill"}
        </Link>
      </div>
      <PageHeader
        title="Review source update"
        description="Executor compares the accepted source, your active revision, and the staged source revision."
        actions={
          <Button
            size="sm"
            loading={applying}
            disabled={unresolved.length > 0}
            onClick={() => void applyUpdate()}
          >
            Apply update
          </Button>
        }
      />
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {review.value.changes.map((change) => (
          <li key={change.path} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-foreground">{change.path}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {change.kind}
                  {change.conflict ? " · Local and upstream changes conflict" : ""}
                </p>
              </div>
              {change.conflict ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={resolutions[change.path] === "local" ? "default" : "outline"}
                    onClick={() =>
                      setResolutions((current) => ({ ...current, [change.path]: "local" }))
                    }
                  >
                    Keep local
                  </Button>
                  <Button
                    size="sm"
                    variant={resolutions[change.path] === "upstream" ? "default" : "outline"}
                    onClick={() =>
                      setResolutions((current) => ({ ...current, [change.path]: "upstream" }))
                    }
                  >
                    Take upstream
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {unresolved.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Resolve every conflicting file before applying the update.
        </p>
      ) : null}
    </PageContainer>
  );
}
