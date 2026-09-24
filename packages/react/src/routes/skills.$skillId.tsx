import { createFileRoute } from "@tanstack/react-router";

import { SkillsRoute } from "./skills-route";

export const Route = createFileRoute("/{-$orgSlug}/skills/$skillId")({
  component: SkillDetailRouteComponent,
});

function SkillDetailRouteComponent() {
  const { skillId } = Route.useParams();
  return <SkillsRoute skillId={skillId} />;
}
