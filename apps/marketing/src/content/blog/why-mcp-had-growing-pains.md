---
title: "Why MCP had so many growing pains"
description: "MCP shipped before anyone knew how to wire tools to agents, and it caught the blame for it. What actually went wrong, why CLIs aren't the answer, and where MCP goes from here."
date: 2026-06-25
author: "Rhys Sullivan"
---

MCP launched when the best models we had were Claude 3.5 Sonnet and GPT-4o. At the time, we did not know how to build with these tools. We were paranoid about security, context bloat, and granting access to models.

Consequently, early MCP servers were useless. Vercel's launch MCP server had only 7 tools and limited utility. Paranoid about security, companies restricted access to the point of making the servers unviable.

When Claude Code launched in February, developers realized agents just needed a bash tool. Giving agents bash access let them chain commands, filter output, and dynamically install CLIs. This shift led to a common belief: the fewer tools a model has, the better it performs. That belief is false. The GitHub CLI contains thousands of tools, especially since a model can call the API directly using `gh api`.

Compare using MCP to using a CLI. With a CLI, you tell the agent to install the package and use it immediately. Most MCP harnesses require a full client restart to register a new tool, creating significant friction. Bash benefits from 37 years of development on stable primitives, while developers rushed out most MCP implementations in a month.

MCP is in an awkward state. Vercel added `vercel api` to its CLI, giving agents access to the entire API. Yet Vercel's MCP server remains restricted to 20 tools, most of which are read-only. Additionally, only 16 clients are authorized to integrate with it. This friction makes no sense when developers routinely run the CLI in environments with skipped permissions.

Should we abandon MCP for CLIs? I disagree. Most CLIs merely wrap APIs. Focusing on CLI authentication while neglecting API authentication introduces unnecessary statefulness. An agent reading emails should not spin up a container to run the Google Workspace CLI when lazy tool loading or code mode works.

CLIs also fail to map the action space. You can convert an MCP tool into a CLI, but you cannot easily reverse the process. CLIs also lack the explicit annotations for destructive actions found in MCP or OpenAPI specifications, though improving LLMs make this less critical.

## Myths surrounding MCP today

**"Lots of tools bloat the context."** This is only true for poorly implemented clients. Most modern clients use lazy loading, letting the model discover tools on demand.

**"Poor support of the spec."** While the spec is not fully supported everywhere, developers can work around missing features. We must solve this adoption chicken-and-egg problem.

**"Auth sucks."** Some clients have poor authorization support. However, in Claude Code, I never get signed out.

**"We should just be calling the APIs directly."** I agree. I founded [executor.sh](https://executor.sh) on this premise. Harnesses should support any integration method, whether it is MCP, CLI, API, or GraphQL. Executor functions by accepting any input format and converting it into a standard tool catalog.

## Where do we go from here?

Harness builders like Codex, Claude Code, and OpenCode will decide whether to commit to MCP. If these teams collaborate on an alternative specification with matching adoption, we should welcome it. From my perspective, MCP's broad adoption has solved the hardest challenge. Now we must focus on refining the implementation.

I am optimistic about the future of MCP. Stateless elicitation is powerful, and client adoption of code mode is rising. MCP applications will unlock new interaction patterns over the next six months. Skill loading through MCP will also provide clear context on how to call remote sources.

Ideally, companies will support CIMD OAuth for both their MCP servers and OpenAPI specifications. Developers can use the OpenAPI spec for raw data access and bulk processing, while the MCP server provides a curated experience using an `api` tool modeled after the Vercel and GitHub CLIs.

## Some closing thoughts

Avoid plugins. They create vendor lock-in and portability issues, resulting in closed ecosystems.

This technology is new, and criticizing it is easier than building it. MCP has succeeded in driving widespread adoption.

Ultimately, most MCP servers and CLIs are just wrappers for direct API calls.
