import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AccountConnectionId, type Provider } from "@executor-js/sdk";
import { Option, Schema } from "effect";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@executor-js/ui/components/dialog";
import { ProviderIcon } from "@executor-js/ui/dashboard/common";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import { QueryResult, useQuery } from "@executor-js/ui/dashboard/context";
import { connectionAtom, PendingOAuth } from "../../contracts/apps.ts";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { ConnectionFields } from "./connect-account.tsx";

/** All connection entry points share the same modal size and submission dismissal guard. */
export function ConnectionModal({
  open,
  busy,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] gap-5 overflow-x-hidden overflow-y-auto sm:max-w-[560px]">
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Use the same provider identity and accessible heading for new accounts and resumed requests. */
export function ConnectionDialogHeader({
  provider,
  action,
  notice,
}: {
  readonly provider: Provider;
  readonly action: "Connect" | "Reconnect";
  readonly notice?: string | undefined;
}) {
  return (
    <div className="flex items-center gap-3 pr-7">
      <ProviderIcon name={provider.definition.name} url={providerDisplayUrl(provider.definition)} />
      <div className="min-w-0">
        <DialogTitle className="text-base">
          {action} {provider.definition.name}
        </DialogTitle>
        <DialogDescription className={notice ? "mt-1 text-xs" : "sr-only"}>
          {notice ?? `${action} an account for ${provider.definition.name}.`}
        </DialogDescription>
      </div>
    </div>
  );
}

/** A connection query parameter opens the existing request over its app or account page. */
export function AccountConnectionDialog({
  connectionId,
  client,
  onClose,
}: {
  readonly connectionId?: AccountConnectionId | undefined;
  readonly client?: "change" | undefined;
  readonly onClose: () => void;
}) {
  return connectionId === undefined ? null : (
    <ResumedConnectionDialog
      key={connectionId}
      connectionId={connectionId}
      client={client}
      onClose={onClose}
    />
  );
}

function ResumedConnectionDialog({
  connectionId,
  client,
  onClose,
}: {
  readonly connectionId: AccountConnectionId;
  readonly client?: "change" | undefined;
  readonly onClose: () => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const query = useQuery(connectionAtom({ organization, connection: connectionId }));
  const connection = Option.getOrUndefined(query.data);
  const [busy, setBusy] = useState(false);
  const [pending] = useState(() =>
    Schema.decodeUnknownOption(Schema.fromJsonString(PendingOAuth))(
      sessionStorage.getItem("executor:hosted:oauth"),
    ),
  );
  const label =
    Option.isSome(pending) && pending.value.connection === connectionId
      ? pending.value.label
      : undefined;
  return (
    <ConnectionModal open busy={busy} onClose={onClose}>
      {connection ? (
        <ConnectionDialogHeader
          provider={connection.provider}
          action={connection.reconnectAccount ? "Reconnect" : "Connect"}
        />
      ) : (
        <>
          <DialogTitle className="text-base">Connect account</DialogTitle>
          <DialogDescription className="sr-only">Load this account connection.</DialogDescription>
        </>
      )}
      <QueryResult
        result={query.result}
        retry={query.refresh}
        Failure={HostedFailure}
        pending={<DetailSkeleton label="Loading account setup" />}
      >
        {(connection) => (
          <ConnectionFields
            connection={connection}
            initialLabel={label}
            manualClient={client === "change"}
            onPendingChange={setBusy}
            onSaved={(account) => {
              void navigate(
                connection.target
                  ? {
                      to: "/org/$organizationSlug/apps/$appId",
                      params: { organizationSlug, appId: connection.target.app },
                      search: { view: "accounts", profile: connection.target.profile },
                      replace: true,
                    }
                  : {
                      to: "/org/$organizationSlug/accounts/$accountId",
                      params: { organizationSlug, accountId: account.id },
                      search: {},
                      replace: true,
                    },
              );
            }}
          />
        )}
      </QueryResult>
    </ConnectionModal>
  );
}

/** Resolve a handoff URL into the owning page's modal; no standalone connection screen exists. */
export function ConnectionEntry({
  connectionId: id,
  client,
}: {
  readonly connectionId: AccountConnectionId;
  readonly client?: "change" | undefined;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const query = useQuery(connectionAtom({ organization, connection: id }));
  const connection = Option.getOrUndefined(query.data);
  useEffect(() => {
    if (connection === undefined) return;
    const search = { connection: connection.id, client };
    void navigate(
      connection.target
        ? {
            to: "/org/$organizationSlug/apps/$appId",
            params: { organizationSlug, appId: connection.target.app },
            search: { ...search, view: "accounts", profile: connection.target.profile },
            replace: true,
          }
        : connection.reconnectAccount
          ? {
              to: "/org/$organizationSlug/accounts/$accountId",
              params: { organizationSlug, accountId: connection.reconnectAccount.id },
              search,
              replace: true,
            }
          : {
              to: "/org/$organizationSlug/accounts",
              params: { organizationSlug },
              search,
              replace: true,
            },
    );
  }, [connection, client, navigate, organizationSlug]);
  return (
    <ConnectionModal
      open
      busy={false}
      onClose={() => {
        void navigate({
          to: "/org/$organizationSlug/accounts",
          params: { organizationSlug },
          search: {},
          replace: true,
        });
      }}
    >
      <DialogTitle className="text-base">Connect account</DialogTitle>
      <DialogDescription className="sr-only">
        Open this connection in its app or account.
      </DialogDescription>
      <QueryResult
        result={query.result}
        retry={query.refresh}
        Failure={HostedFailure}
        pending={<DetailSkeleton label="Loading account setup" />}
      >
        {() => <DetailSkeleton label="Opening account setup" />}
      </QueryResult>
    </ConnectionModal>
  );
}
