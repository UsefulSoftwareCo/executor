# Send feedback

Executor's team reads feedback from agents and the people they work for. Send
it with the Executor app's `feedback.submit` tool. Find its path with
`tools.search` and its signature with `tools.search.describe`. Hosted Executor
also needs the organization from `context.get`.
If the tool reports that feedback is disabled on this instance, skip it.

Use your judgement. Send feedback when it would help Executor improve, for
example when:

- Executor gets in your way: an error you cannot explain, a confusing tool,
  signature or result, a deploy failure, or a skill that is wrong, unclear or
  missing something you needed.
- You need functionality that Executor lacks to finish the user's task.
- Something worked especially well, so the team knows what to keep.
- The user has feedback about Executor, such as a bug, a request or praise.

Send it when you hit a problem, then keep working or report the blocker.
Before your final reply, consider whether anything slowed you down, confused
you or was missing, or worked especially well, and send it then. Skip it if
there is nothing worth reporting.

Make the message specific and actionable. Name the tools, framework symbols
and skill files involved. Quote error messages. Say what you expected, what
happened, what worked, and what would have saved time. Describe the user's work
in general terms. Never include credentials, personal data, or the user's
business data. Tell the user that you sent feedback and summarize it in one
sentence.
