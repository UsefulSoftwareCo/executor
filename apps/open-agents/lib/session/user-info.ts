import "server-only";
import { hasGitHubAccount as checkGitHubLinked } from "@/lib/github/users";
import { getInstallationsByUserId } from "@/lib/db/installations";
import {
  getGhCliToken,
  getGlobalGitHubToken,
  isGhCliAuthEnabled,
} from "@/lib/github/token";
import { isUserAdmin, userExists } from "@/lib/db/users";
import { isManagedTemplateTrialUser } from "@/lib/managed-template-trial";
import type { Session, SessionUserInfo } from "./types";

const UNAUTHENTICATED: SessionUserInfo = { user: undefined };

export async function getSessionUserInfo(
  session: Session | null | undefined,
  requestUrl: string | URL,
): Promise<SessionUserInfo> {
  if (!session?.user?.id) {
    return UNAUTHENTICATED;
  }

  const [exists, hasGitHubAccount, installations, isAdmin, sharedGitHubToken] =
    await Promise.all([
      userExists(session.user.id),
      checkGitHubLinked(session.user.id),
      getInstallationsByUserId(session.user.id),
      isUserAdmin(session.user.id),
      getGlobalGitHubToken() ??
        (isGhCliAuthEnabled() ? getGhCliToken() : Promise.resolve(null)),
    ]);

  if (!exists) {
    return UNAUTHENTICATED;
  }

  const hasGitHubInstallations = installations.length > 0;
  const hasGitHubCli = sharedGitHubToken != null;
  const hasGitHub = hasGitHubAccount || hasGitHubInstallations || hasGitHubCli;

  return {
    user: session.user,
    authProvider: session.authProvider,
    isAdmin,
    isManagedTemplateTrialUser: isManagedTemplateTrialUser(
      session,
      requestUrl,
    ),
    hasGitHub,
    hasGitHubAccount,
    hasGitHubInstallations,
    hasGitHubCli,
  };
}
