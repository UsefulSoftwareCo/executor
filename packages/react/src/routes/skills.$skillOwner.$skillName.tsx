import { createFileRoute } from "@tanstack/react-router";

import { SkillsRoute } from "./skills-route";

export const Route = createFileRoute("/{-$orgSlug}/skills/$skillOwner/$skillName")({
  component: SkillDetailRouteComponent,
});

function SkillDetailRouteComponent() {
  const { skillOwner, skillName } = Route.useParams();
  const { edit } = Route.useSearch();
  return <SkillsRoute skillOwner={skillOwner} skillName={skillName} editing={edit} />;
}
