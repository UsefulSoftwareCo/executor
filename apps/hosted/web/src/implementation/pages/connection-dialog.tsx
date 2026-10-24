import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AccountConnectionId, type Provider } from "@executor-js/sdk";
import type { HostedAccountConnection } from "@executor-js/hosted-server";
import type { CatalogConnectionNotice } from "@executor-js/catalog/contracts";
import { AsyncResult } from "effect/reactivity";
import { Option } from "effect";
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
import { appAtom, connectionAtom } from "../../contracts/apps.ts";
import { catalogAtom } from "../../contracts/api.ts";
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

/** Explain operator-supplied provider restrictions before the person starts sign-in. */
export function ConnectionNotices({
  provider,
  notices,
}: {
  readonly provider: Provider;
  readonly notices: readonly CatalogConnectionNotice[];
}) {
  const providerName = provider.definition.name;
  const messages = notices
    .filter((notice) => notice.providerName === providerName)
    .map(({ message }) => message);
  if (messages.length === 0) return null;
  return (
    <div
      role="note"
      aria-label={`${providerName} connection notices`}
      className="space-y-1 text-sm"
    >
      <p className="font-medium">Before you connect</p>
      <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
        {messages.map((message, index) => (
          <li key={`${providerName}:${index}`}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

/** A connection query parameter opens the existing request over its app page. */
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
  const { organization } = useOrganizationRoute();
  const query = useQuery(connectionAtom({ organization, connection: connectionId }));
  const [busy, setBusy] = useState(false);
  return (
    <ConnectionModal open busy={busy} onClose={onClose}>
      <QueryResult
        result={query.result}
        retry={query.refresh}
        Failure={HostedFailure}
        pending={<DetailSkeleton label="Loading account setup" />}
      >
        {(connection) => (
          <ResumedConnectionDetails
            connection={connection}
            client={client}
            onPendingChange={setBusy}
          />
        )}
      </QueryResult>
    </ConnectionModal>
  );
}

function ResumedConnectionDetails({
  connection,
  client,
  onPendingChange,
}: {
  readonly connection: HostedAccountConnection;
  readonly client?: "change" | undefined;
  readonly onPendingChange: (pending: boolean) => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const appQuery = useQuery(appAtom({ organization, app: connection.target.app }));
  const app = Option.getOrUndefined(appQuery.data);
  const appUnavailable =
    app === undefined || appQuery.result.waiting || AsyncResult.isFailure(appQuery.result);
  const catalog = useQuery(catalogAtom);
  const catalogEntries = Option.getOrUndefined(AsyncResult.value(catalog.result));
  const catalogEntry = catalogEntries?.find((entry) => entry.package === app?.copiedFrom?.name);
  const catalogUnavailable =
    app?.copiedFrom?.name !== undefined &&
    (catalogEntries === undefined ||
      catalog.result.waiting ||
      AsyncResult.isFailure(catalog.result));

  return (
    <>
      <ConnectionDialogHeader
        provider={connection.provider}
        action={connection.reconnectAccount ? "Reconnect" : "Connect"}
      />
      {appUnavailable ? (
        AsyncResult.isFailure(appQuery.result) ? (
          <HostedFailure cause={appQuery.result.cause} retry={appQuery.refresh} layout="compact" />
        ) : appQuery.result.waiting ? (
          <DetailSkeleton label="Loading app details" />
        ) : (
          <p role="alert" className="text-sm text-muted-foreground">
            This app is unavailable, so its connection details cannot be checked.
          </p>
        )
      ) : catalogUnavailable ? (
        AsyncResult.isFailure(catalog.result) ? (
          <HostedFailure cause={catalog.result.cause} retry={catalog.refresh} layout="compact" />
        ) : (
          <DetailSkeleton label="Loading connection details" />
        )
      ) : (
        <>
          <ConnectionNotices
            provider={connection.provider}
            notices={catalogEntry?.connectionNotices ?? []}
          />
          <ConnectionFields
            connection={connection}
            manualClient={client === "change"}
            onPendingChange={onPendingChange}
            onSaved={() => {
              void navigate({
                to: "/org/$organizationSlug/apps/$appId",
                params: { organizationSlug, appId: connection.target.app },
                search: { view: "accounts" },
                replace: true,
              });
            }}
          />
        </>
      )}
    </>
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
    void navigate({
      to: "/org/$organizationSlug/apps/$appId",
      params: { organizationSlug, appId: connection.target.app },
      search: { ...search, view: "accounts" },
      replace: true,
    });
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
