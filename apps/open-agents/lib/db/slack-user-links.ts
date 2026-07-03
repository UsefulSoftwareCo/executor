import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./client";
import { slackUserLinks, type SlackUserLink } from "./schema";

export const DEFAULT_SLACK_TEAM_ID = "default";

export function normalizeSlackTeamId(slackTeamId: string | null | undefined): string {
  const trimmed = slackTeamId?.trim();
  return trimmed ? trimmed : DEFAULT_SLACK_TEAM_ID;
}

export function normalizeSlackUserId(slackUserId: string): string {
  return slackUserId.trim().toUpperCase();
}

export async function getSlackUserLinkByUserId(
  userId: string,
): Promise<SlackUserLink | null> {
  const [link] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.userId, userId))
    .limit(1);

  return link ?? null;
}

export async function getSlackUserLinkBySlackIdentity(params: {
  slackTeamId?: string | null;
  slackUserId: string;
}): Promise<SlackUserLink | null> {
  const [link] = await db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackTeamId, normalizeSlackTeamId(params.slackTeamId)),
        eq(slackUserLinks.slackUserId, normalizeSlackUserId(params.slackUserId)),
      ),
    )
    .limit(1);

  return link ?? null;
}

export async function upsertSlackUserLink(params: {
  userId: string;
  slackTeamId?: string | null;
  slackUserId: string;
  slackUserName?: string | null;
}): Promise<SlackUserLink> {
  const values = {
    id: nanoid(),
    userId: params.userId,
    slackTeamId: normalizeSlackTeamId(params.slackTeamId),
    slackUserId: normalizeSlackUserId(params.slackUserId),
    slackUserName: params.slackUserName?.trim() || null,
    updatedAt: new Date(),
  };

  const [link] = await db
    .insert(slackUserLinks)
    .values(values)
    .onConflictDoUpdate({
      target: slackUserLinks.userId,
      set: {
        slackTeamId: values.slackTeamId,
        slackUserId: values.slackUserId,
        slackUserName: values.slackUserName,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  if (!link) {
    throw new Error("Failed to save Slack user link");
  }

  return link;
}

export async function deleteSlackUserLink(userId: string): Promise<void> {
  await db.delete(slackUserLinks).where(eq(slackUserLinks.userId, userId));
}
