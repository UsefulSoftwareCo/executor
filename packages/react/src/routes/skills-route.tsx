import { Owner, SkillName } from "@executor-js/sdk/shared";

import { SkillDetailPage, SkillMissingPage } from "../pages/skill-detail";
import { SkillEditorPage } from "../pages/skill-editor";
import { SkillsPage } from "../pages/skills";

/** The URL's owner segment, or `null` when it is neither `org` nor `user`. */
const parseOwner = (value: string): Owner | null =>
  value === "org" || value === "user" ? value : null;

/**
 * The one component every skills route renders. `/skills/new` and
 * `/skills/$skillOwner/$skillName` generate as CHILDREN of `/skills` and the
 * parent renders no `<Outlet/>`, so the parent resolves which view to show —
 * the shape `artifacts-route.tsx` established.
 */
export function SkillsRoute(props: {
  readonly skillOwner?: string | undefined;
  readonly skillName?: string | undefined;
  /** `?edit` on a skill URL. Ignored on the list and on `/skills/new`. */
  readonly editing?: boolean | undefined;
  /** True on `/skills/new`, which carries no params to recognize it by. */
  readonly creating?: boolean | undefined;
}) {
  if (props.skillOwner === undefined || props.skillName === undefined) {
    return props.creating ? <SkillEditorPage /> : <SkillsPage />;
  }

  const owner = parseOwner(props.skillOwner);
  // Only a hand-typed URL gets here with an owner that is neither `org` nor
  // `user`. There is no row to ask for, so say so without a fetch.
  if (owner === null) return <SkillMissingPage />;

  const ref = { owner, name: SkillName.make(props.skillName) } as const;
  return props.editing ? <SkillEditorPage editing={ref} /> : <SkillDetailPage {...ref} />;
}
