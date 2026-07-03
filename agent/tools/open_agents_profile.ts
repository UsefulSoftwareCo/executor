import { defineDynamic, defineTool, type ToolDefinition } from "eve/tools";
import { loadSkill, todo, webFetch } from "eve/tools/defaults";
import { type OpenAgentsProfileTool, resolveOpenAgentsProfile } from "../lib/open-agents-profile";
import { OPEN_AGENTS_SESSION_TOOLS } from "../lib/open-agents-session-tools";

const DEFAULT_TOOLS = {
  bash: OPEN_AGENTS_SESSION_TOOLS.bash,
  glob: OPEN_AGENTS_SESSION_TOOLS.glob,
  grep: OPEN_AGENTS_SESSION_TOOLS.grep,
  load_skill: loadSkill,
  read_file: OPEN_AGENTS_SESSION_TOOLS.read_file,
  todo,
  web_fetch: webFetch,
  write_file: OPEN_AGENTS_SESSION_TOOLS.write_file,
} satisfies Record<OpenAgentsProfileTool, ToolDefinition>;

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const profile = await resolveOpenAgentsProfile(ctx);
      return Object.fromEntries(
        profile.tools.map((toolName) => [toolName, defineTool(DEFAULT_TOOLS[toolName])]),
      );
    },
  },
});
