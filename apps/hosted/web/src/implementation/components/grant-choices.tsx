import { useEffect, useState, type ReactNode } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type {
  ApprovalMode,
  GrantAccessChoice,
  GrantSettings,
  GrantTarget,
} from "@executor-js/mcp-auth/grants";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import {
  McpConsentAccess,
  McpConsentApprovals,
  McpConsentRow,
  McpConsentRowFailure,
  McpConsentRowPending,
  McpConsentSelect,
  McpConsentTargetRows,
  type ConsentConnectionList,
} from "@executor-js/ui/dashboard/mcp-consent";
import {
  ConnectionOwnerRequest,
  connectionOwnerAtom,
  consentConnectionsAtom,
} from "../../contracts/mcp-connections.ts";
import type { OrganizationSummary } from "../../contracts/organization.ts";

/** A connection being created in another tab: the list it started from, in its organization. */
interface PendingConnection {
  readonly organization: OrganizationId;
  readonly known: ReadonlySet<string>;
}

/** What approving sends: the organization header, when the page knows it, and the settings. */
export interface GrantDecision {
  readonly organization: string | undefined;
  readonly settings: GrantSettings | undefined;
}

const listFailure = "Could not load.";

/**
 * The organization, access and approval rows of a hosted sign-in, and the decision they make. The
 * request's resource preselects the access and approvals; the person may change both, and the
 * page sends exactly what it shows. API sign-in shows its access as a plain value.
 */
export function useGrantChoices({
  target,
  organizations,
  disabled,
}: {
  readonly target: GrantTarget;
  readonly organizations: readonly OrganizationSummary[];
  readonly disabled: boolean;
}): { readonly rows: ReactNode; readonly decision: GrantDecision; readonly ready: boolean } {
  const named = target.kind === "mcp" ? target.connection : undefined;
  const [chosen, setChosen] = useState<OrganizationId>();
  const [access, setAccess] = useState<GrantAccessChoice>(
    named === undefined ? { kind: "all" } : { kind: "connection", id: named },
  );
  const [mode, setMode] = useState<ApprovalMode | undefined>(
    target.kind === "mcp" ? target.mode : undefined,
  );
  const [pending, setPending] = useState<PendingConnection>();
  // A named connection fixes the organization; with several, the page looks for it first.
  const lookup = named !== undefined && organizations.length > 1 && chosen === undefined;
  const organization = lookup ? undefined : (chosen ?? organizations[0]?.id);
  const chooseOrganization = (next: OrganizationId) => {
    setChosen(next);
    setPending(undefined);
    // A connection belongs to one organization, so it is never in the next one's list.
    if (next !== organization) setAccess({ kind: "all" });
  };
  const choose = (next: GrantAccessChoice) => {
    setPending(undefined);
    setAccess(next);
  };
  const openEditor = (known: ReadonlySet<string>) => {
    const slug = organizations.find((item) => item.id === organization)?.slug;
    if (organization === undefined || slug === undefined) return;
    window.open(`/org/${encodeURIComponent(slug)}/connect/new`, "_blank", "noreferrer");
    setPending({ organization, known });
  };
  const organizationRow = lookup ? (
    <ConnectionOwner
      request={
        new ConnectionOwnerRequest({
          organizations: organizations.map((item) => item.id),
          connection: named,
        })
      }
      onFound={(found) => setChosen(found ?? organizations[0]?.id)}
    />
  ) : organizations.length === 1 ? (
    <McpConsentRow label="Organization">{organizations[0]?.name}</McpConsentRow>
  ) : (
    <McpConsentRow label="Organization" htmlFor="mcp-organization">
      <McpConsentSelect
        id="mcp-organization"
        value={organization ?? ""}
        options={organizations.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(value) => {
          const next = organizations.find((item) => item.id === value);
          if (next !== undefined) chooseOrganization(next.id);
        }}
        disabled={disabled}
      />
    </McpConsentRow>
  );
  const rows =
    target.kind === "api" ? (
      <>
        {organizationRow}
        <McpConsentTargetRows target={target} />
      </>
    ) : (
      <>
        {organizationRow}
        {organization === undefined ? (
          // Until its organization is found, the named connection is the access.
          <McpConsentRow label="Access">One of your connections</McpConsentRow>
        ) : (
          <ConnectionChoice
            organization={organization}
            value={access}
            onChange={choose}
            pending={pending?.organization === organization ? pending : undefined}
            onNewConnection={openEditor}
            disabled={disabled}
          />
        )}
        {mode !== undefined && (
          <McpConsentApprovals mode={mode} onMode={setMode} disabled={disabled} />
        )}
      </>
    );
  return {
    rows,
    decision: {
      organization,
      settings: target.kind === "api" || mode === undefined ? undefined : { access, mode },
    },
    // Without an organization the server takes the named connection's own.
    ready: organization !== undefined || named !== undefined,
  };
}

/** Finds which organization holds the connection the request names. */
function ConnectionOwner({
  request,
  onFound,
}: {
  readonly request: ConnectionOwnerRequest;
  readonly onFound: (organization: OrganizationId | undefined) => void;
}) {
  const atom = connectionOwnerAtom(request);
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const found = AsyncResult.isSuccess(result) ? result.value : undefined;
  useEffect(() => {
    if (found !== undefined) onFound(Option.getOrUndefined(found));
  }, [found, onFound]);
  return AsyncResult.isFailure(result) ? (
    <McpConsentRowFailure
      label="Organization"
      message={listFailure}
      retry={retry}
      retrying={result.waiting}
    />
  ) : (
    <McpConsentRowPending label="Organization" />
  );
}

/**
 * The organization's connections as the Access menu. The menu shows the choice at once and reads
 * the list inside it. A connection created in another tab since "New connection" was chosen
 * becomes the choice when the list shows it.
 */
function ConnectionChoice({
  organization,
  value,
  onChange,
  pending,
  onNewConnection,
  disabled,
}: {
  readonly organization: OrganizationId;
  readonly value: GrantAccessChoice;
  readonly onChange: (value: GrantAccessChoice) => void;
  readonly pending: PendingConnection | undefined;
  readonly onNewConnection: (known: ReadonlySet<string>) => void;
  readonly disabled: boolean;
}) {
  const atom = consentConnectionsAtom(organization);
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const connections = Option.getOrUndefined(AsyncResult.value(result));
  const created =
    pending === undefined
      ? undefined
      : connections?.findLast((connection) => !pending.known.has(connection.id));
  useEffect(() => {
    if (created !== undefined) onChange({ kind: "connection", id: created.id });
  }, [created, onChange]);
  // A retry in flight reads as loading again.
  const list: ConsentConnectionList =
    connections !== undefined
      ? { kind: "loaded", connections }
      : AsyncResult.isFailure(result) && !result.waiting
        ? { kind: "failed", retry }
        : { kind: "loading" };
  return (
    <McpConsentAccess
      list={list}
      value={value}
      onChange={onChange}
      onNewConnection={(known) => onNewConnection(new Set(known.map((item) => item.id)))}
      disabled={disabled}
    />
  );
}
