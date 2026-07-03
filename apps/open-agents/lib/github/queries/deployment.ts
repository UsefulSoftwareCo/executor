"use server";

import { AuthzError, requireSessionAccess } from "@open-agents/authz";
import { getSessionById } from "@/lib/db/sessions";
import { findDeploymentUrl } from "@/lib/github/pulls";
import { getUserGitHubToken } from "@/lib/github/token";
import {
  findLatestBuildingDeploymentUrlForBranch,
  findLatestFailedDeploymentInspectorUrlForBranch,
  findLatestPreviewDeploymentUrlForBranch,
} from "@/lib/vercel/projects";
import { getUserVercelToken } from "@/lib/vercel/token";
import { getServerSession } from "@/lib/session/get-server-session";

// ---- types ----

export type PrDeploymentResponse = {
  deploymentUrl: string | null;
  buildingDeploymentUrl?: string | null;
  failedDeploymentUrl?: string | null;
};

// ---- helpers ----

async function requireAuth() {
  const session = await getServerSession();
  if (!session?.user) {
    throw new Error("Not authenticated");
  }
  return session;
}

async function requireAccessibleSession(userId: string, sessionId: string) {
  try {
    await requireSessionAccess({ kind: "user", userId }, sessionId, "read");
  } catch (error) {
    if (error instanceof AuthzError) {
      throw new Error(error.status === 404 ? "Session not found" : "Forbidden");
    }
    throw error;
  }

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    throw new Error("Session not found");
  }
  return sessionRecord;
}

// ---- server action ----

export async function getDeploymentUrl(params: {
  sessionId: string;
  prNumber?: number;
  branch?: string;
}): Promise<PrDeploymentResponse> {
  const { sessionId, prNumber, branch } = params;

  const session = await requireAuth();
  const sessionRecord = await requireAccessibleSession(session.user.id, sessionId);

  // validate prNumber if provided
  if (prNumber !== undefined && (Number.isNaN(prNumber) || prNumber <= 0)) {
    return { deploymentUrl: null };
  }

  if (
    prNumber !== undefined &&
    sessionRecord.prNumber !== null &&
    prNumber !== sessionRecord.prNumber
  ) {
    return { deploymentUrl: null };
  }

  const previewLookupBranch = branch ?? sessionRecord.branch;

  // try the Vercel API first
  if (sessionRecord.vercelProjectId && previewLookupBranch) {
    const vercelToken = await getUserVercelToken(session.user.id);
    if (vercelToken) {
      const lookupParams = {
        token: vercelToken,
        projectIdOrName: sessionRecord.vercelProjectId,
        branch: previewLookupBranch,
        teamId: sessionRecord.vercelTeamId,
      };

      const [deploymentUrl, buildingDeploymentUrl, failedDeploymentUrl] =
        await Promise.all([
          findLatestPreviewDeploymentUrlForBranch(lookupParams).catch(
            () => null,
          ),
          findLatestBuildingDeploymentUrlForBranch(lookupParams).catch(
            () => null,
          ),
          findLatestFailedDeploymentInspectorUrlForBranch(lookupParams).catch(
            () => null,
          ),
        ]);

      if (deploymentUrl || buildingDeploymentUrl || failedDeploymentUrl) {
        return {
          deploymentUrl,
          buildingDeploymentUrl,
          failedDeploymentUrl,
        };
      }
    }
  }

  // fall back to searching GitHub PR comments for Vercel deployment URLs
  if (
    !sessionRecord.repoOwner ||
    !sessionRecord.repoName ||
    sessionRecord.prNumber === null
  ) {
    return { deploymentUrl: null };
  }

  const token = await getUserGitHubToken(session.user.id);
  if (!token) {
    return { deploymentUrl: null };
  }

  const deploymentResult = await findDeploymentUrl({
    owner: sessionRecord.repoOwner,
    repo: sessionRecord.repoName,
    prNumber: sessionRecord.prNumber,
    token,
  });

  if (!deploymentResult.success) {
    return { deploymentUrl: null };
  }

  return {
    deploymentUrl: deploymentResult.deploymentUrl ?? null,
  };
}
