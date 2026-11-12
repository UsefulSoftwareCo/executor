/**
 * A run's aggregate report: the per-organization reports' fields summed or listed with their
 * organization, which organizations have no report yet, and which of those stopped without one
 * (their Workflow instance errored or was terminated) and need a person. It is internal, like each
 * report.
 *
 * A run's reports are combined a page at a time (`addReports`), so no request reads every report
 * or holds them all: each page's partial aggregate is kept between pages.
 */
import type {
  V1ImportAggregate,
  V1OrgReport,
  V1ImportErrored,
} from "../../contracts/v1-import-run.ts";

/** The aggregate of no reports, which each page adds to. */
export const emptyAggregate = (runId: string): V1ImportAggregate => ({
  runId,
  complete: true,
  organizations: 0,
  pending: [],
  errored: [],
  statuses: {},
  counts: { v1: {}, v2: {} },
  heldBack: [],
  failed: [],
  blocked: [],
  emailMatches: [],
  skippedMembers: [],
  slugChanges: [],
  integrationFailures: [],
  droppedTraceTools: [],
  connectionFailures: { byReason: {}, connections: [] },
  firstPartyMismatches: [],
  unmatchedRules: [],
  staleItems: { byCategory: {}, items: [] },
  droppedCredentials: [],
  memberSecretMismatches: [],
  orgApiKeys: [],
  artifacts: [],
  flags: { sso: [], ssoUnread: [], overFreeMemberLimit: [], paid: [] },
  vaultFailures: [],
  splitIntegrations: [],
});

const sum = (
  into: Readonly<Record<string, number>>,
  from: Readonly<Record<string, number>>,
): Record<string, number> => {
  const total = { ...into };
  for (const [key, value] of Object.entries(from)) total[key] = (total[key] ?? 0) + value;
  return total;
};

/** Each report's list entries, tagged with the organization they came from. */
const listed = <A>(
  reports: readonly V1OrgReport[],
  present: (report: V1OrgReport) => readonly A[],
) =>
  reports.flatMap((report) =>
    present(report).map((entry) => ({ organization: report.organization, entry })),
  );

const where = (reports: readonly V1OrgReport[], keep: (report: V1OrgReport) => boolean) =>
  reports.flatMap((report) => (keep(report) ? [report.organization] : []));

/** The aggregate with one page of the run's organizations added. */
export const addReports = (
  aggregate: V1ImportAggregate,
  reports: readonly V1OrgReport[],
  pending: readonly string[],
  errored: ReadonlyArray<typeof V1ImportErrored.Type>,
): V1ImportAggregate => {
  let v1 = aggregate.counts.v1;
  let v2 = aggregate.counts.v2;
  let statuses = aggregate.statuses;
  let byReason = aggregate.connectionFailures.byReason;
  let byCategory = aggregate.staleItems.byCategory;
  for (const report of reports) {
    v1 = sum(v1, report.counts.v1);
    v2 = sum(v2, report.counts.v2);
    statuses = sum(statuses, { [report.status]: 1 });
    for (const failure of report.connectionFailures)
      byReason = sum(byReason, { [failure.reason]: failure.connections.length });
    for (const item of report.staleItems)
      byCategory = sum(byCategory, { [`${item.kind} ${item.category}`]: 1 });
  }
  const pendingAll = [...aggregate.pending, ...pending];
  const erroredAll = [...aggregate.errored, ...errored];
  return {
    runId: aggregate.runId,
    complete: pendingAll.length === 0 && erroredAll.length === 0,
    organizations: aggregate.organizations + reports.length + pending.length + errored.length,
    pending: pendingAll,
    errored: erroredAll,
    statuses,
    counts: { v1, v2 },
    heldBack: [
      ...aggregate.heldBack,
      ...reports.flatMap((report) =>
        report.status === "held_back"
          ? [{ organization: report.organization, reason: report.reason }]
          : [],
      ),
    ],
    failed: [
      ...aggregate.failed,
      ...reports.flatMap((report) =>
        report.status === "failed"
          ? [{ organization: report.organization, reason: report.reason }]
          : [],
      ),
    ],
    blocked: [...aggregate.blocked, ...where(reports, (report) => report.status === "blocked")],
    emailMatches: [...aggregate.emailMatches, ...listed(reports, (report) => report.emailMatches)],
    skippedMembers: [
      ...aggregate.skippedMembers,
      ...listed(reports, (report) => report.skippedMembers),
    ],
    slugChanges: [
      ...aggregate.slugChanges,
      ...reports.flatMap((report) =>
        report.slug?.changed === true || report.slug?.displaced !== undefined
          ? [{ organization: report.organization, ...report.slug }]
          : [],
      ),
    ],
    integrationFailures: [
      ...aggregate.integrationFailures,
      ...listed(reports, (report) => report.integrationFailures),
    ],
    droppedTraceTools: [
      ...aggregate.droppedTraceTools,
      ...listed(reports, (report) => report.droppedTraceTools),
    ],
    connectionFailures: {
      byReason,
      connections: [
        ...aggregate.connectionFailures.connections,
        ...listed(reports, (report) => report.connectionFailures),
      ],
    },
    firstPartyMismatches: [
      ...aggregate.firstPartyMismatches,
      ...listed(reports, (report) => report.firstPartyMismatches),
    ],
    unmatchedRules: [
      ...aggregate.unmatchedRules,
      ...listed(reports, (report) => report.unmatchedRules),
    ],
    staleItems: {
      byCategory,
      items: [...aggregate.staleItems.items, ...listed(reports, (report) => report.staleItems)],
    },
    droppedCredentials: [
      ...aggregate.droppedCredentials,
      ...listed(reports, (report) => report.droppedCredentials),
    ],
    memberSecretMismatches: [
      ...aggregate.memberSecretMismatches,
      ...listed(reports, (report) => report.memberSecretMismatches),
    ],
    orgApiKeys: [
      ...aggregate.orgApiKeys,
      ...reports.flatMap((report): V1ImportAggregate["orgApiKeys"] =>
        report.orgApiKeys.read
          ? report.orgApiKeys.keys.length > 0
            ? [{ organization: report.organization, ...report.orgApiKeys }]
            : []
          : [{ organization: report.organization, read: false }],
      ),
    ],
    artifacts: [...aggregate.artifacts, ...listed(reports, (report) => report.artifacts)],
    flags: {
      sso: [...aggregate.flags.sso, ...where(reports, (report) => report.flags.sso === true)],
      ssoUnread: [
        ...aggregate.flags.ssoUnread,
        ...where(reports, (report) => report.flags.sso === null),
      ],
      overFreeMemberLimit: [
        ...aggregate.flags.overFreeMemberLimit,
        ...where(reports, (report) => report.flags.overFreeMemberLimit),
      ],
      paid: [
        ...aggregate.flags.paid,
        ...reports.flatMap((report) =>
          report.flags.paidPlans.length > 0
            ? [{ organization: report.organization, plans: report.flags.paidPlans }]
            : [],
        ),
      ],
    },
    vaultFailures: [
      ...aggregate.vaultFailures,
      ...listed(reports, (report) => report.vaultFailures),
    ],
    splitIntegrations: [
      ...(aggregate.splitIntegrations ?? []),
      ...listed(reports, (report) => report.splitIntegrations ?? []),
    ],
  };
};
