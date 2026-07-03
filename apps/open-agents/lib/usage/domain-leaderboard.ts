import { getUsageLeaderboardDomain } from "@/lib/usage/leaderboard-domain";
import type { UsageDomainLeaderboardRow } from "@/lib/usage/types";

export { getUsageLeaderboardDomain };

export interface UsageDomainLeaderboardQueryRow {
  userId: string;
  email: string | null;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  modelId: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function shouldReplaceMostUsedModel(params: {
  currentModelId: string | null;
  currentTokens: number;
  candidateModelId: string | null;
  candidateTokens: number;
}): boolean {
  const { currentModelId, currentTokens, candidateModelId, candidateTokens } =
    params;

  if (candidateTokens > currentTokens) {
    return true;
  }

  if (candidateTokens < currentTokens) {
    return false;
  }

  if (currentModelId === null && candidateModelId !== null) {
    return true;
  }

  if (currentModelId !== null && candidateModelId === null) {
    return false;
  }

  if (currentModelId === null || candidateModelId === null) {
    return false;
  }

  return candidateModelId < currentModelId;
}

export function buildUsageDomainLeaderboardRows(
  rows: UsageDomainLeaderboardQueryRow[],
): UsageDomainLeaderboardRow[] {
  const leaderboard = new Map<string, UsageDomainLeaderboardRow>();

  for (const row of rows) {
    if (!row.email) {
      continue;
    }

    const modelTokens = row.totalInputTokens + row.totalOutputTokens;
    const existing = leaderboard.get(row.userId);

    if (existing) {
      existing.totalTokens += modelTokens;
      if (
        shouldReplaceMostUsedModel({
          currentModelId: existing.mostUsedModelId,
          currentTokens: existing.mostUsedModelTokens,
          candidateModelId: row.modelId,
          candidateTokens: modelTokens,
        })
      ) {
        existing.mostUsedModelId = row.modelId;
        existing.mostUsedModelTokens = modelTokens;
      }
      continue;
    }

    leaderboard.set(row.userId, {
      userId: row.userId,
      username: row.username,
      name: row.name,
      avatarUrl: row.avatarUrl,
      totalTokens: modelTokens,
      mostUsedModelId: row.modelId,
      mostUsedModelTokens: modelTokens,
    });
  }

  return [...leaderboard.values()]
    .filter((row) => row.totalTokens > 0)
    .toSorted((a, b) => {
      if (b.totalTokens !== a.totalTokens) {
        return b.totalTokens - a.totalTokens;
      }

      const usernameOrder = a.username.localeCompare(b.username);
      if (usernameOrder !== 0) {
        return usernameOrder;
      }

      return a.userId.localeCompare(b.userId);
    });
}
