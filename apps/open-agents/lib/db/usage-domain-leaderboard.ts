import { eq, sql } from "drizzle-orm";
import type { UsageDateRange } from "@/lib/usage/date-range";
import type { UsageDomainLeaderboard } from "@/lib/usage/types";
import {
  buildUsageDomainLeaderboardRows,
  getUsageLeaderboardDomain,
  type UsageDomainLeaderboardQueryRow,
} from "@/lib/usage/domain-leaderboard";
import { db } from "./client";
import { usageEvents, users } from "./schema";

export interface UsageDomainLeaderboardOptions {
  days?: number;
  range?: UsageDateRange;
}

function buildUsageDomainLeaderboardWhereClause(
  domain: string,
  options?: UsageDomainLeaderboardOptions,
) {
  if (options?.range) {
    return sql`${users.email} is not null and lower(split_part(${users.email}, '@', 2)) = ${domain} and date(${usageEvents.createdAt}) >= ${options.range.from} and date(${usageEvents.createdAt}) <= ${options.range.to}`;
  }

  const days = options?.days ?? 280;
  const since = new Date();
  since.setDate(since.getDate() - days);

  return sql`${users.email} is not null and lower(split_part(${users.email}, '@', 2)) = ${domain} and ${usageEvents.createdAt} >= ${since.toISOString()}`;
}

export async function getUsageDomainLeaderboard(
  email: string | null | undefined,
  options?: UsageDomainLeaderboardOptions,
): Promise<UsageDomainLeaderboard | null> {
  const domain = getUsageLeaderboardDomain(email);
  if (!domain) {
    return null;
  }

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      username: users.username,
      name: users.name,
      avatarUrl: users.avatarUrl,
      modelId: usageEvents.modelId,
      totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::double precision`,
      totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::double precision`,
    })
    .from(usageEvents)
    .innerJoin(users, eq(usageEvents.userId, users.id))
    .where(buildUsageDomainLeaderboardWhereClause(domain, options))
    .groupBy(
      users.id,
      users.email,
      users.username,
      users.name,
      users.avatarUrl,
      usageEvents.modelId,
    );

  return {
    domain,
    rows: buildUsageDomainLeaderboardRows(rows),
  };
}
