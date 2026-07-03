import { NextRequest } from "next/server";
import {
  deleteSlackUserLink,
  getSlackUserLinkByUserId,
  normalizeSlackTeamId,
  normalizeSlackUserId,
  upsertSlackUserLink,
} from "@/lib/db/slack-user-links";
import { getSessionFromReq } from "@/lib/session/server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function serializeSlackLink(
  link: Awaited<ReturnType<typeof getSlackUserLinkByUserId>>,
) {
  return link
    ? {
        slackTeamId: link.slackTeamId,
        slackUserId: link.slackUserId,
        slackUserName: link.slackUserName,
        updatedAt: link.updatedAt.toISOString(),
      }
    : null;
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromReq(req);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const link = await getSlackUserLinkByUserId(session.user.id);
  return Response.json({ link: serializeSlackLink(link) });
}

export async function PUT(req: NextRequest) {
  const session = await getSessionFromReq(req);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!isRecord(body)) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const slackUserId = readString(body.slackUserId);
  if (!slackUserId) {
    return Response.json({ error: "slackUserId is required" }, { status: 400 });
  }

  try {
    const link = await upsertSlackUserLink({
      userId: session.user.id,
      slackTeamId: normalizeSlackTeamId(readString(body.slackTeamId)),
      slackUserId: normalizeSlackUserId(slackUserId),
      slackUserName: readString(body.slackUserName),
    });

    return Response.json({ link: serializeSlackLink(link) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("slack_user_links_identity_idx")) {
      return Response.json(
        { error: "That Slack user is already linked to another account" },
        { status: 409 },
      );
    }

    throw error;
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSessionFromReq(req);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  await deleteSlackUserLink(session.user.id);
  return Response.json({ ok: true });
}
