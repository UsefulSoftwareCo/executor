import { defineDynamic, defineSkill } from "eve/skills";
import {
  dynamicSkillName,
  resolveOpenAgentsProfile,
} from "../lib/open-agents-profile";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const profile = await resolveOpenAgentsProfile(ctx);
      if (profile.skills.length === 0) {
        return null;
      }

      return Object.fromEntries(
        profile.skills.map((skill) => [
          dynamicSkillName(skill),
          defineSkill({
            description: skill.description,
            markdown: skill.markdown,
            metadata: {
              id: skill.id,
              name: skill.name,
            },
          }),
        ]),
      );
    },
  },
});
