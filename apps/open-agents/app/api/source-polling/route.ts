import { ensureSourcePollingWorkflow } from "@/lib/source-polling/kick";

export const maxDuration = 120;

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return true;
  }

  const authorization = request.headers.get("authorization");
  return authorization === `Bearer ${cronSecret}`;
}

async function handleSourcePollingRequest(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await ensureSourcePollingWorkflow();
  return Response.json({ ok: true, ...result });
}

export async function GET(request: Request): Promise<Response> {
  return handleSourcePollingRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSourcePollingRequest(request);
}
