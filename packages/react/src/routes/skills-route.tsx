import { ManagedSkillId } from "@executor-js/sdk/shared";

import { SkillDetailPage } from "../pages/skill-detail";
import { SkillEditorPage } from "../pages/skill-editor";
import { SkillsPage } from "../pages/skills";

export function SkillsRoute(props: {
  readonly skillId?: string | undefined;
  readonly creating?: boolean | undefined;
  readonly editing?: boolean | undefined;
}) {
  if (props.creating) return <SkillEditorPage />;
  if (props.skillId === undefined) return <SkillsPage />;
  const skillId = ManagedSkillId.make(props.skillId);
  return props.editing ? (
    <SkillEditorPage skillId={skillId} />
  ) : (
    <SkillDetailPage skillId={skillId} />
  );
}
