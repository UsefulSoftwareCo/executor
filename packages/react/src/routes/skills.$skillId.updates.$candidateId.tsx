import { createFileRoute } from "@tanstack/react-router";
import { ManagedSkillId, SkillCandidateId } from "@executor-js/sdk/shared";

import { SkillUpdatePage } from "../pages/skill-update";

export const Route = createFileRoute("/{-$orgSlug}/skills/$skillId/updates/$candidateId")({
  component: SkillUpdateRouteComponent,
});

function SkillUpdateRouteComponent() {
  const { skillId, candidateId } = Route.useParams();
  return (
    <SkillUpdatePage
      skillId={ManagedSkillId.make(skillId)}
      candidateId={SkillCandidateId.make(candidateId)}
    />
  );
}
