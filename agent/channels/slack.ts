import { slackChannel, type SlackContext, type SlackMessage } from "eve/channels/slack";
import {
  getOrCreateOpenAgentsSlackSession,
  initializeOpenAgentsSlackSessionSandbox,
  markOpenAgentsSlackSessionLinkPosted,
  runOpenAgentsSlackTurn,
} from "../lib/open-agents-slack-session";

async function handleSlackMessage(ctx: SlackContext, message: SlackMessage) {
  if (!message.author) {
    console.info("[slack] dropping message without author", {
      channelId: message.channelId,
      teamId: message.teamId ?? null,
      threadTs: message.threadTs,
    });
    return null;
  }

  console.info("[slack] received message", {
    attachmentCount: message.attachments.length,
    channelId: message.channelId,
    teamId: message.teamId ?? null,
    textLength: message.text.length,
    threadTs: message.threadTs,
    userId: message.author.userId,
  });

  if (!message.text.trim() && message.attachments.length === 0) {
    await ctx.thread.post(
      "Send me a task. Include a GitHub repo URL if this should target a specific repository.",
    );
    return null;
  }

  await ctx.thread.startTyping("Thinking...");

  let session;
  try {
    session = await getOrCreateOpenAgentsSlackSession({
      slackChannelId: message.channelId,
      slackTeamId: message.teamId,
      slackThreadTs: message.threadTs,
      slackUserId: message.author.userId,
      text: message.text,
    });
  } catch (error) {
    console.error("[slack] failed to start Open Agents session", {
      channelId: message.channelId,
      error,
      teamId: message.teamId ?? null,
      threadTs: message.threadTs,
      userId: message.author.userId,
    });
    await ctx.thread.post("Failed to start the Open Agents session.");
    return null;
  }

  if (!session) {
    console.info("[slack] Open Agents user link not found", {
      teamId: message.teamId ?? null,
      userId: message.author.userId,
    });
    await ctx.thread.post(
      [
        "I received your request, but your Slack user is not linked to Open Agents.",
        "",
        `Slack team ID: \`${message.teamId ?? "default"}\``,
        `Slack user ID: \`${message.author.userId}\``,
      ].join("\n"),
    );
    return null;
  }

  console.info("[slack] started Open Agents session", {
    chatId: session.chatId,
    created: session.created,
    sessionId: session.sessionId,
    teamId: message.teamId ?? null,
    userId: message.author.userId,
  });

  const shouldPostSessionLink = !session.linkPostedAt;
  if (shouldPostSessionLink) {
    await ctx.thread.post(`Started Open Agents session: ${session.sessionUrl}`);
    await markOpenAgentsSlackSessionLinkPosted(session);
    session = { ...session, linkPostedAt: new Date() };
  }

  if (session.created) {
    try {
      await initializeOpenAgentsSlackSessionSandbox(session);
      await ctx.thread.post("Workspace sandbox is ready.");
    } catch (error) {
      console.error("[slack] failed to initialize Open Agents sandbox", {
        channelId: message.channelId,
        error,
        sessionId: session.sessionId,
        teamId: message.teamId ?? null,
        threadTs: message.threadTs,
        userId: message.author.userId,
      });
      await ctx.thread.post("Session created, but sandbox initialization failed.");
      return null;
    }
  }

  let turn: Awaited<ReturnType<typeof runOpenAgentsSlackTurn>>;
  try {
    turn = await runOpenAgentsSlackTurn({
      message,
      session,
    });
  } catch (error) {
    console.error("[slack] Open Agents turn failed", {
      channelId: message.channelId,
      error,
      sessionId: session.sessionId,
      teamId: message.teamId ?? null,
      threadTs: message.threadTs,
      userId: message.author.userId,
    });
    await ctx.thread.post("The Open Agents session started, but the agent turn failed.");
    return null;
  }

  if (turn.status === "busy") {
    await ctx.thread.post("I am still working on the previous message in this thread.");
    return null;
  }

  await ctx.thread.post(turn.message ?? "I finished the turn, but did not produce a text response.");

  return null;
}

export default slackChannel({
  onAppMention: handleSlackMessage,
  onDirectMessage: handleSlackMessage,
  threadContext: { since: "last-agent-reply" },
});
