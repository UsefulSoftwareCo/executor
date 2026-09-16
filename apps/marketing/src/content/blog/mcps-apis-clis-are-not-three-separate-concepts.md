---
title: "MCPs, APIs, and CLIs are not three separate concepts"
description: "They are all ways to invoke tools, that's it. How I think about tool calling, the different specifications, when to use each, and the underlying concepts."
date: 2026-06-26
author: "Rhys Sullivan"
---

MCPs, APIs, CLIs, are all ways to invoke tools. That's it.

The goal of this article is to help share how I think about tool calling, the different specifications, when to use each, and the underlying concepts.

As a thought experiment, consider what happens when you convert an MCP to a CLI. The actual underlying tools have not changed. All that's changed is your execution environment.

Hammering this point again: context bloat is not an MCP problem. It is a problem of the implementation of how tools are exposed to the model.

If a company has an MCP server, you want it to have as many tools as possible, as that's more capabilities your agent is able to do on your behalf.

My personal [executor.sh](https://executor.sh) instance has ~10,000 tools in it, a mix of MCP and APIs, and agents are able to work beautifully with it.

So, with it established that they're all the same underlying concept, why do these three exist? When do you use one vs the other?

## MCP

MCP seems to be the right protocol to use for any interactions that are with agents. Some examples of this:

- [Claude Channels](https://code.claude.com/docs/en/channels-reference) is built on MCP and allows you to push data back into a running session via an MCP.
- MCP Apps allows for embedding UI directly inside of chats, i.e. "show me a chart of my PostHog data."
- MCP Elicitation enables getting actual input from humans. This is really useful when you need them to confirm something like "are you okay with analytics" or going to a URL to perform an action.
- [MCP Triggers](https://modelcontextprotocol.io/community/working-groups/triggers-events) to notify clients of state changes.

Now the trouble with these is there's a chicken and egg problem. Most clients only implement support for MCP tools and that's it. What's cool though is you can actually work around partial client support by doing the same functionality over tool calls only as a fallback, which I'll have a longer post coming on.

## APIs

Where I'm landing on APIs is they're great for raw data access and quickly converting your app to be agent accessible. APIs carry good information already about their descriptions, what operations are destructive / not destructive / etc.

To me, it doesn't make sense to try to get behavior like MCP Apps, elicitation, triggers through OpenAPI, as that's not meant to be for agents. MCP is.

## CLI

This is going to be controversial, but I really think that CLIs are just for humans when looking at the long term horizon. A big part of this comes down to the known action space of a CLI, in that for people that want to know what an agent is actually able to do.

The other part about CLIs is requiring a Unix shell to run them. When we look at enabling every person in the world to have a personal assistant or interact with their data through AI, the overhead of CLIs very quickly makes this not possible.

That's not to say that they're bad though. I would easily argue the CLIs produced by [@steipete](https://x.com/steipete) are state of the art for agents because of how much care has been put into the design of their interfaces, their ability to get data in hard to reach places, etc.

Today CLIs provide the best debuggability, interfacing, data access, etc. to agents because of the beautiful composability of bash and everything running them locally on your computer enables.

Back in March we saw a lot of writing around "building CLIs for agents," and fundamentally it just comes down to bash being the wrong primitive for agents to be using. There's too many footguns for them to get trapped in, i.e. when they run a command that prompts for human input.

## Closing

At the end of the day, you can convert an API into an MCP into a CLI back into an MCP back into an API.

They're all the same concept: giving the agent the ability to invoke tools. What changes is the amount of dependencies and capabilities the agent gets when using it.

APIs are probably fine for 90% of applications. CLIs are the best for agents today just due to the robustness of bash. MCP has a lot of potential to solve the problems presented by using CLIs today. However, it's going to require spec improvements and good harness implementations, so hopefully Fable comes back.
