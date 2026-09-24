import { createFileRoute } from "@tanstack/react-router";

import { SkillsRoute } from "./skills-route";

export const Route = createFileRoute("/{-$orgSlug}/skills/$skillId/edit")({
  component: SkillEditRouteComponent,
});

function SkillEditRouteComponent() {
  const { skillId } = Route.useParams();
  return <SkillsRoute skillId={skillId} editing />;
}
