import type { Integration } from "@executor-js/sdk/shared";

export const MULTI_SERVICE_FAMILIES: ReadonlySet<string> = new Set(["google", "microsoft"]);

const FAMILY_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

export const familyLabel = (family: string): string =>
  FAMILY_LABELS[family] ?? family.charAt(0).toUpperCase() + family.slice(1);

export const integrationFamily = (integration: Integration): string | null => {
  const family = integration.family?.trim();
  return family && MULTI_SERVICE_FAMILIES.has(family) ? family : null;
};

export interface IntegrationFamilyGroup {
  readonly type: "group";
  readonly family: string;
  readonly label: string;
  readonly members: readonly Integration[];
}

export interface IntegrationSingle {
  readonly type: "single";
  readonly integration: Integration;
}

export type IntegrationGridItem = IntegrationFamilyGroup | IntegrationSingle;

export function groupIntegrations(
  integrations: readonly Integration[],
): readonly IntegrationGridItem[] {
  const familyCounts = new Map<string, number>();
  for (const integration of integrations) {
    const family = integrationFamily(integration);
    if (family) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  const items: IntegrationGridItem[] = [];
  const groupIndexByFamily = new Map<string, number>();

  for (const integration of integrations) {
    const family = integrationFamily(integration);
    const grouped = family !== null && (familyCounts.get(family) ?? 0) > 1;

    if (!grouped || family === null) {
      items.push({ type: "single", integration });
      continue;
    }

    const existing = groupIndexByFamily.get(family);
    if (existing === undefined) {
      groupIndexByFamily.set(family, items.length);
      items.push({
        type: "group",
        family,
        label: familyLabel(family),
        members: [integration],
      });
    } else {
      const group = items[existing] as IntegrationFamilyGroup;
      items[existing] = { ...group, members: [...group.members, integration] };
    }
  }

  return items;
}
