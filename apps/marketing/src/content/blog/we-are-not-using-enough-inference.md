---
title: "We're not using enough inference"
description: "We're going to look back on the amount of inference we used in 2026 as laughably small. Some exploratory thinking about what a world of free, abundant attention looks like."
date: 2026-08-09
author: "Rhys Sullivan"
---

We're going to look back on the amount of inference we used in 2026 as laughably small.

In order to properly read this article, you have to assume two things are true:

- The cost of inference is going to 0.
- Agents will be good enough to autonomously review changes, merge code, and act.

So, what does this world of infinite high quality inference look like? Exploring some examples.

## React2Shell

The moment this CVE announcement was made, every Next.js site should have been instantly upgraded by an agent.

What's interesting here is attackers will also have lists of every Next.js site on the internet maintained along with autonomous attacker agents. The same agents that are good enough to autonomously upgrade sites are also good enough to exploit them.

Defenders are in a significantly worse position than attackers here. Whatever autonomous fixes that are being deployed need to not break production or cause more security issues. Defenders have to be close to perfect, attackers just have to find a gap.

## OpenAI x Hugging Face security incident

If OpenAI had another LLM that was monitoring either the traces coming out of the evaluated LLMs, monitoring what was being written to the package manager, monitoring the network logs, they would've been able to catch the security incident before it became a problem.

## Session replays

It's not just security that you can throw inference at. Every session your users have on your site can be recorded and checked for issues on where users get confused, where layout shift or jank occurs. All of these problems are measurable and solvable.

## Closing

What to think about here is essentially when you hit a problem in your day to day, whether that problem could've been solvable or detectable by throwing more inference at it. The answer is likely yes.

The XZ Utils SSH backdoor was detected because an engineer noticed a 500ms delay in SSH. So many problems are detectable and solvable but go unnoticed due to a lack of attention. When that attention is free and abundant you're able to solve these problems.

A lot of bottlenecks have been on attention and hours in the day. Your session replays only have relevance if people watch them. Now you've got agents that are able to.

There's a ton of problems this world creates as well. Where are these autonomous agents running? What credentials do they have access to?

On deployment, are these agents deploying autonomously to production? If so, incremental rollouts are likely needed, feature flags, instant rollbacks, etc.

I hear the screaming about the problems with agents autonomously deploying, but my prediction is that the model capabilities will become so good, it will actually be irresponsible to be bottlenecked on human engineers to solve these problems. If it takes 10 minutes for your engineer to be paged at 2 am, wake up, review a PR, send it live vs 1 minute for an agent, in a world where there's automated attackers the 10 minute window becomes significantly more risky.

None of our tooling today is really built with this unlimited inference world in mind, but as model capabilities rapidly improve it will need to be too.
