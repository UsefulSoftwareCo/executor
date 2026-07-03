import { defineDynamic, defineTool } from "eve/tools";
import { loadSkill, todo, webFetch } from "eve/tools/defaults";
import { type OpenAgentsProfileTool, resolveOpenAgentsProfile } from "../lib/open-agents-profile";
import { OPEN_AGENTS_SESSION_TOOLS } from "../lib/open-agents-session-tools";

const DEFAULT_TOOLS = {
  bash: () => defineTool(OPEN_AGENTS_SESSION_TOOLS.bash),
  glob: () => defineTool(OPEN_AGENTS_SESSION_TOOLS.glob),
  grep: () => defineTool(OPEN_AGENTS_SESSION_TOOLS.grep),
  load_skill: () => defineTool(loadSkill),
  read_file: () => defineTool(OPEN_AGENTS_SESSION_TOOLS.read_file),
  todo: () => defineTool(todo),
  web_fetch: () => defineTool(webFetch),
  write_file: () => defineTool(OPEN_AGENTS_SESSION_TOOLS.write_file),
} satisfies Record<OpenAgentsProfileTool, () => unknown>;

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const profile = await resolveOpenAgentsProfile(ctx);
      return Object.fromEntries(
        profile.tools.map((toolName) => [toolName, DEFAULT_TOOLS[toolName]()]),
      );
    },
  },
});
