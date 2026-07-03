import { NextResponse } from "next/server";
import { getInstallationsByUserId } from "@/lib/db/installations";
import {
  getGhCliToken,
  getGlobalGitHubToken,
  isGhCliAuthEnabled,
} from "@/lib/github/token";
import { getInstallationManageUrl } from "@/lib/github/urls";
import { fetchGitHubOrgs, fetchGitHubUser } from "@/lib/github/users";
import { getServerSession } from "@/lib/session/get-server-session";

export async function GET() {
  const session = await getServerSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const installations = await getInstallationsByUserId(session.user.id);
    const installationOptions = installations.map((installation) => ({
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      installationUrl: getInstallationManageUrl(
        installation.installationId,
        installation.installationUrl,
      ),
    }));

    const sharedGitHubToken =
      getGlobalGitHubToken() ??
      (isGhCliAuthEnabled() ? await getGhCliToken() : null);

    if (sharedGitHubToken) {
      const [user, orgs] = await Promise.all([
        fetchGitHubUser(sharedGitHubToken),
        fetchGitHubOrgs(sharedGitHubToken),
      ]);
      const existingOwners = new Set(
        installationOptions.map((option) => option.accountLogin),
      );
      const sharedTokenAccounts = [
        ...(user
          ? [
              {
                accountLogin: user.login,
                accountType: "User" as const,
              },
            ]
          : []),
        ...(orgs ?? []).map((org) => ({
          accountLogin: org.login,
          accountType: "Organization" as const,
        })),
      ].filter((account) => !existingOwners.has(account.accountLogin));

      installationOptions.push(
        ...sharedTokenAccounts.map((account, index) => ({
          installationId: -(index + 1),
          accountLogin: account.accountLogin,
          accountType: account.accountType,
          repositorySelection: "all" as const,
          installationUrl: null,
        })),
      );
    }

    return NextResponse.json(installationOptions);
  } catch (error) {
    console.error("Failed to fetch GitHub installations:", error);
    return NextResponse.json(
      { error: "Failed to fetch installations" },
      { status: 500 },
    );
  }
}
