/* oxlint-disable executor/no-promise-catch -- boundary: cron route accepts optional JSON and uses a stable default when absent */
import { start } from "workflow/api";
import { automationSchedulerWorkflow } from "@/app/workflows/automation-scheduler";

export const maxDuration = 120;

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return true;
  }
  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

async function handleSchedulerRequest(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const nowIso =
    typeof body?.nowIso === "string" ? body.nowIso : new Date().toISOString();
  const run = await start(automationSchedulerWorkflow, [nowIso]);
  return Response.json({ ok: true, eveSessionId: run.runId }, { status: 202 });
}

export async function GET(request: Request) {
  return handleSchedulerRequest(request);
}

export async function POST(request: Request) {
  return handleSchedulerRequest(request);
}
