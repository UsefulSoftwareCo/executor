import type { NextRequest } from "next/server";
import { getSessionFromReq } from "@/lib/session/server";
import { getSessionUserInfo } from "@/lib/session/user-info";

export async function GET(req: NextRequest) {
  const session = await getSessionFromReq(req);
  return Response.json(await getSessionUserInfo(session, req.url));
}
