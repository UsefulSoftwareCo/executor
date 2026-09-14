import { createFileRoute, useLocation, useParams } from "@tanstack/react-router";

import { SkillsRoute } from "./skills-route";

/** `?edit` puts the skill URL into its editor. Declared on the PARENT because
 *  `/skills/new` and `/skills/$skillOwner/$skillName` are generated as its
 *  children and inherit its search contract. */
interface SkillsSearch {
  readonly edit?: true;
}

export const Route = createFileRoute("/{-$orgSlug}/skills")({
  component: SkillsRouteComponent,
  validateSearch: (search: Record<string, unknown>): SkillsSearch =>
    search.edit === undefined ? {} : { edit: true },
});

function SkillsRouteComponent() {
  // Both child routes generate UNDER this one and this component renders no
  // <Outlet/>, so the parent has to serve all three URLs — the shape
  // `artifacts.tsx` established. `/skills/new` carries no params at all, so the
  // pathname is the only thing that tells it apart from the list.
  const { skillOwner, skillName } = useParams({ strict: false }) as {
    skillOwner?: string;
    skillName?: string;
  };
  const pathname = useLocation({ select: (location) => location.pathname });
  const { edit } = Route.useSearch();
  return (
    <SkillsRoute
      skillOwner={skillOwner}
      skillName={skillName}
      editing={edit}
      creating={pathname.endsWith("/skills/new")}
    />
  );
}
