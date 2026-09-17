---
title: "I don't want to use your agent"
description: "I want to use the skills, knowledge, and APIs your company has spent years developing, not your custom agent. How to enable power users without abandoning everyone else."
date: 2026-06-27
author: "Rhys Sullivan"
---

I want to use the skills, knowledge, and APIs your company has spent years developing, not your custom agent.

Almost every company by this point has shipped an agent. There's a Cloudflare agent in their dashboard, a PostHog agent, a Mercury agent, a Linear agent, the list goes on. Each week we see a homepage fall to a chat interface.

I don't actually think this is a bad thing, quite the opposite. Interacting with sites through an agent is magical.

The problem is, I don't want to use any of these, for a variety of reasons.

## Incentives

One of the biggest is the incentive problem. I am always running Opus 4.8 or GPT 5.5. The costs for a company to provide this for free for all their users is unsustainable.

What ends up happening is most of the time when you're chatting with an agent on a website, you're dealing with a quantized version of Kimi 2.5, and while it gets the job done, it's not your agent.

I'm paying for the best models. I want to use the best models for my work.

## Context

When I am in the Linear agent on the web UI, it's lacking the ability for me to bring in my local files, random git repositories, etc.

They can go build this functionality and are, but you're never going to beat me running my local setup.

## So, what do I want?

I want my agent to become an expert in your product and problem area.

For Linear this looks like a set of skills to help me break down my largest problems into actionable tickets.

For Cloudflare this looks like detailed docs on their extensive product surface and CLI commands to run.

For PostHog, this is the data to query, deeplinked UI components to help me visualize data, skills to help me grow my product.

The same knowledge and expertise that you embed into your UI and documentation needs to become accessible to my daily driver agent.

## Enabling this

The problem is, I am a power user of these tools. I have multiple Max subscriptions across different providers, am swapping tooling constantly. I am not representative of most users.

So how do you enable the power users of this technology while not forgetting about the people that genuinely do want to use your in-app agent, Slack bot, etc?

You build your internal agent off of the same primitives your power users will be using. This roughly looks like:

- Some form of harness (pi, OpenCode, a harness SDK, can be lightweight)
- Skills
- MCP / API

When landing on a chat, have some form of prompt that's like "want to continue in your own agent? install the MCP/CLI and skills."

Your regular users can dismiss it and keep using your built-in chat. Your power users can embed your product directly into their agent. And you only have one source of truth to maintain.
