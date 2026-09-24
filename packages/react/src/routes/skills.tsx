import { createFileRoute, useLocation, useParams } from "@tanstack/react-router";

import { SkillsRoute } from "./skills-route";

export const Route = createFileRoute("/{-$orgSlug}/skills")({
  component: SkillsRouteComponent,
});

function SkillsRouteComponent() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { skillId } = useParams({ strict: false }) as { skillId?: string };
  return (
    <SkillsRoute
      skillId={skillId}
      creating={pathname.endsWith("/skills/new")}
      editing={pathname.endsWith("/edit")}
    />
  );
}
