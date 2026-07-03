import { connectSandbox } from "@open-agents/sandbox";
import { installConfiguredSessionClis } from "@open-agents/sandbox/session-clis.js";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
} from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import {
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_VCPUS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  buildHibernatedLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle-state";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  clearSandboxResumeState,
  getResumableSandboxName,
  hasRuntimeSandboxState,
  isSandboxNotFoundError,
} from "@/lib/sandbox/utils";

interface ResumeSandboxRequest {
  sessionId: string;
}

export async function PUT(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: ResumeSandboxRequest;
  try {
    body = (await req.json()) as ResumeSandboxRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  const sandboxType = sessionRecord.sandboxState?.type ?? "vercel";

  if (sandboxType !== "vercel") {
    return Response.json(
      {
        error:
          "Sandbox resume is only supported for the current cloud sandbox provider",
      },
      { status: 400 },
    );
  }

  if (hasRuntimeSandboxState(sessionRecord.sandboxState)) {
    const resumedFrom =
      getResumableSandboxName(sessionRecord.sandboxState) ?? undefined;
    console.log(
      `[Sandbox Resume] session=${sessionId} already_running=true sandboxType=${sandboxType}`,
    );
    return Response.json({
      success: true,
      alreadyRunning: true,
      resumedFrom,
    });
  }

  const persistentSandboxName = getResumableSandboxName(
    sessionRecord.sandboxState,
  );

  if (!persistentSandboxName) {
    console.error(
      `[Sandbox Resume] session=${sessionId} error=no_resume_state sandboxType=${sandboxType}`,
    );
    return Response.json(
      { error: "No sandbox available for resume" },
      { status: 404 },
    );
  }

  try {
    const resumedFrom = persistentSandboxName;
    const sandbox = await connectSandbox(
      { type: sandboxType, sandboxName: persistentSandboxName },
      {
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        vcpus: DEFAULT_SANDBOX_VCPUS,
        ports: DEFAULT_SANDBOX_PORTS,
        resume: true,
        hooks: {
          afterStart: installConfiguredSessionClis,
        },
      },
    );

    const newState = sandbox.getState?.();
    const resumedState = (newState ?? {
      type: sandboxType,
      sandboxName: persistentSandboxName,
    }) as Parameters<typeof updateSession>[1]["sandboxState"];

    await updateSession(sessionId, {
      sandboxState: resumedState,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildActiveLifecycleUpdate(resumedState),
    });

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "sandbox-resumed",
    });

    const resumedSandboxName =
      getResumableSandboxName(resumedState) ?? "unknown";
    console.log(
      `[Sandbox Resume] session=${sessionId} success=true sandboxType=${sandboxType} sandboxName=${resumedSandboxName} resumedFrom=${resumedFrom}`,
    );

    return Response.json({
      success: true,
      resumedFrom,
      sandboxName: getResumableSandboxName(resumedState) ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isSandboxNotFoundError(message)) {
      await updateSession(sessionId, {
        sandboxState: clearSandboxResumeState(sessionRecord.sandboxState),
        ...buildHibernatedLifecycleUpdate(),
      });
      console.error(
        `[Sandbox Resume] session=${sessionId} success=false error=${message}`,
      );
      return Response.json(
        {
          error: "Saved sandbox is no longer available. Create a new sandbox.",
        },
        { status: 404 },
      );
    }

    console.error(
      `[Sandbox Resume] session=${sessionId} success=false error=${message}`,
    );
    return Response.json(
      { error: `Failed to resume sandbox: ${message}` },
      { status: 500 },
    );
  }
}
