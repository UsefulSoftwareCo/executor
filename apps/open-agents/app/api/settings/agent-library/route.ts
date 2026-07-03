import { canAccess, getDefaultOrgId, type Scope } from "@open-agents/authz";
import { getServerSession } from "@/lib/session/get-server-session";
import { getUserPreferences, updateUserPreferences } from "@/lib/db/user-preferences";
import {
  agentEditorInputSchema,
  skillEditorInputSchema,
  type AgentLibrarySaveScope,
} from "@/lib/agents/definitions";
import {
  deleteAgentDefinition,
  deleteSkillDocument,
  getAgentDefinition,
  listAgentLibrary,
  saveAgentDefinition,
  saveSkillDocument,
} from "@/lib/agents/repository";

type SaveRequest =
  | {
      kind: "agent";
      item: unknown;
      setDefault?: boolean;
      scope?: AgentLibrarySaveScope;
      scopeId?: string;
    }
  | { kind: "skill"; item: unknown; scope?: AgentLibrarySaveScope; scopeId?: string };

type PatchRequest = {
  defaultAgentName?: string | null;
};

function parseSaveScope(value: unknown): AgentLibrarySaveScope | null {
  if (value === undefined) {
    return "user";
  }
  return value === "user" || value === "group" || value === "org" ? value : null;
}

function parseGroupScopeId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveLibraryScope(
  userId: string,
  scopeKind: AgentLibrarySaveScope,
  providedScopeId: unknown,
): Promise<Scope | null> {
  if (scopeKind === "user") {
    return { scopeKind, scopeId: userId };
  }

  if (scopeKind === "org") {
    return { scopeKind, scopeId: await getDefaultOrgId() };
  }

  const scopeId = parseGroupScopeId(providedScopeId);
  return scopeId ? { scopeKind, scopeId } : null;
}

async function requireManageLibraryScope(userId: string, scope: Scope): Promise<Response | null> {
  const allowed = await canAccess({ kind: "user", userId }, scope, "manage");
  return allowed
    ? null
    : Response.json({ error: "You do not have permission to manage this scope." }, { status: 403 });
}

async function requireUser() {
  const session = await getServerSession();
  if (!session?.user) {
    return null;
  }
  return session.user;
}

export async function GET() {
  const user = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const preferences = await getUserPreferences(user.id);
  return Response.json({
    library: await listAgentLibrary(preferences.defaultAgentName, user.id),
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: SaveRequest;
  try {
    body = (await req.json()) as SaveRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.kind === "agent") {
      const parsed = agentEditorInputSchema.safeParse(body.item);
      if (!parsed.success) {
        return Response.json({ error: "Invalid agent" }, { status: 400 });
      }

      const scope = parseSaveScope(body.scope);
      if (!scope) {
        return Response.json({ error: "Invalid scope" }, { status: 400 });
      }

      const targetScope = await resolveLibraryScope(user.id, scope, body.scopeId);
      if (!targetScope) {
        return Response.json({ error: "Group scopeId is required" }, { status: 400 });
      }

      const forbidden = await requireManageLibraryScope(user.id, targetScope);
      if (forbidden) {
        return forbidden;
      }

      const item = await saveAgentDefinition(parsed.data, user.id, scope, targetScope.scopeId);
      const preferences = body.setDefault
        ? await updateUserPreferences(user.id, { defaultAgentName: item.slug })
        : await getUserPreferences(user.id);
      return Response.json({
        item,
        library: await listAgentLibrary(preferences.defaultAgentName, user.id),
      });
    }

    if (body.kind === "skill") {
      const parsed = skillEditorInputSchema.safeParse(body.item);
      if (!parsed.success) {
        return Response.json({ error: "Invalid skill" }, { status: 400 });
      }

      const scope = parseSaveScope(body.scope);
      if (!scope) {
        return Response.json({ error: "Invalid scope" }, { status: 400 });
      }

      const targetScope = await resolveLibraryScope(user.id, scope, body.scopeId);
      if (!targetScope) {
        return Response.json({ error: "Group scopeId is required" }, { status: 400 });
      }

      const forbidden = await requireManageLibraryScope(user.id, targetScope);
      if (forbidden) {
        return forbidden;
      }

      const item = await saveSkillDocument(parsed.data, user.id, scope, targetScope.scopeId);
      const preferences = await getUserPreferences(user.id);
      return Response.json({
        item,
        library: await listAgentLibrary(preferences.defaultAgentName, user.id),
      });
    }
  } catch (error) {
    console.error("Failed to save agent library item:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to save item" },
      { status: 500 },
    );
  }

  return Response.json({ error: "Invalid library item kind" }, { status: 400 });
}

export async function PATCH(req: Request) {
  const user = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: PatchRequest;
  try {
    body = (await req.json()) as PatchRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body.defaultAgentName !== undefined &&
    body.defaultAgentName !== null &&
    typeof body.defaultAgentName !== "string"
  ) {
    return Response.json({ error: "Invalid default agent" }, { status: 400 });
  }

  const defaultAgentName = body.defaultAgentName?.trim() || null;
  if (defaultAgentName) {
    const agent = await getAgentDefinition(defaultAgentName, user.id);
    if (!agent) {
      return Response.json({ error: "Default agent not found" }, { status: 400 });
    }
  }

  const preferences = await updateUserPreferences(user.id, { defaultAgentName });
  return Response.json({
    library: await listAgentLibrary(preferences.defaultAgentName, user.id),
  });
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const id = url.searchParams.get("id");
  const scope = parseSaveScope(url.searchParams.get("scope") ?? undefined);
  if (!scope) {
    return Response.json({ error: "Invalid scope" }, { status: 400 });
  }
  if (!id || (kind !== "agent" && kind !== "skill")) {
    return Response.json({ error: "kind and id are required" }, { status: 400 });
  }

  const targetScope = await resolveLibraryScope(user.id, scope, url.searchParams.get("scopeId"));
  if (!targetScope) {
    return Response.json({ error: "Group scopeId is required" }, { status: 400 });
  }

  const forbidden = await requireManageLibraryScope(user.id, targetScope);
  if (forbidden) {
    return forbidden;
  }

  try {
    if (kind === "agent") {
      await deleteAgentDefinition(id, user.id, scope, targetScope.scopeId);
      const preferences = await getUserPreferences(user.id);
      const defaultAgentName =
        preferences.defaultAgentName === id ? null : preferences.defaultAgentName;
      if (preferences.defaultAgentName === id) {
        await updateUserPreferences(user.id, { defaultAgentName });
      }
      return Response.json({
        library: await listAgentLibrary(defaultAgentName, user.id),
      });
    }

    await deleteSkillDocument(id, user.id, scope, targetScope.scopeId);
    const preferences = await getUserPreferences(user.id);
    return Response.json({
      library: await listAgentLibrary(preferences.defaultAgentName, user.id),
    });
  } catch (error) {
    console.error("Failed to delete agent library item:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to delete item" },
      { status: 500 },
    );
  }
}
