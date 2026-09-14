import { createFileRoute } from "@tanstack/react-router";

import { SkillsRoute } from "./skills-route";

export const Route = createFileRoute("/{-$orgSlug}/skills/new")({
  component: NewSkillRouteComponent,
});

function NewSkillRouteComponent() {
  return <SkillsRoute creating />;
}
