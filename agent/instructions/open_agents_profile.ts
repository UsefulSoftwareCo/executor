import { defineDynamic, defineInstructions } from "eve/instructions";
import { hasConfiguredBraintrustCliCredentials } from "@open-agents/sandbox/braintrust-cli.js";
import { hasConfiguredDatadogPupCliCredentials } from "@open-agents/sandbox/datadog-pup-cli.js";
import { hasConfiguredSnowflakeCliCredentials } from "@open-agents/sandbox/snowflake-cli.js";
import { resolveOpenAgentsProfile } from "../lib/open-agents-profile";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const profile = await resolveOpenAgentsProfile(ctx);
      const sections = [
        [
          `OpenAgents session tool profile: ${profile.tools.join(", ") || "none"}.`,
          "This session has an Open Agents workspace sandbox. Use the workspace tools exposed in this chat to inspect and modify it.",
          "Do not call the Open Agents web app, Vercel SSO pages, or `/api/eve/executor` to inspect the current workspace.",
        ].join("\n"),
      ];

      if (profile.workspaceRepos.length > 0) {
        sections.push(
          [
            "Workspace repositories are already cloned under the sandbox working directory:",
            ...profile.workspaceRepos.map(
              (repo) => `- ${repo.owner}/${repo.repo} at ${repo.directory} (${repo.branch})`,
            ),
            "Start workspace inspection with `pwd && ls -la` or by reading files from those directories.",
          ].join("\n"),
        );
      }

      if (profile.agentDisplayName || profile.agentName) {
        sections.push(
          `OpenAgents agent profile: ${profile.agentDisplayName ?? profile.agentName}.`,
        );
      }

      if (hasConfiguredSnowflakeCliCredentials()) {
        sections.push(
          "Snowflake CLI is configured in this workspace sandbox. Use `snow sql --connection openagents --query '<read-only SQL>' --format JSON` for Snowflake queries.",
        );
      }

      if (hasConfiguredBraintrustCliCredentials()) {
        sections.push(
          "Braintrust CLI is configured in this workspace sandbox. Use `bt projects --json list`, `bt view`, and `bt sql` commands for Braintrust inspection.",
        );
      }

      if (hasConfiguredDatadogPupCliCredentials()) {
        sections.push(
          "Datadog Pup CLI is configured in this workspace sandbox. Use `pup auth test --output json`, `pup monitors list --output json`, `pup logs search --query '<query>' --from 1h --output json`, and other `pup` commands for Datadog inspection. Prefer read-only API commands over `pup auth status` in headless sandboxes because status checks OAuth secure storage first.",
        );
      }

      if (profile.customInstructions) {
        sections.push(profile.customInstructions);
      }

      return defineInstructions({
        markdown: sections.join("\n\n"),
      });
    },
  },
});
