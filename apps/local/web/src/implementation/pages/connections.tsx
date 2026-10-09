/**
 * Connections page prototype (EXE-2). Real connections, apps and MCP URLs only.
 * Each scoped card opens its own page, where access is edited in place.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ConnectIcon } from "@hugeicons/core-free-icons";
import type { App, AppId } from "@executor-js/sdk";
import type { ConnectionView } from "@executor-js/mcp-auth/connections";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { PageFrame } from "@executor-js/ui/dashboard/page";
import { ProviderIcon } from "@executor-js/ui/dashboard/common";
import { McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import { useQuery } from "@executor-js/ui/dashboard/context";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import { overviewAtom } from "../../contracts/api.ts";
import { mcpConnectionsAtom } from "../../contracts/mcp-connections.ts";
import { mcpInstallationAtom } from "../../contracts/mcp.ts";
import { LoadingRows } from "../components/common.tsx";

interface ConnectionApp {
  readonly app: App | undefined;
  readonly name: string;
}

/** The full-access endpoint, then each scoped connection. */
interface Connection {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly full: boolean;
  readonly apps: readonly ConnectionApp[];
}

const connectionsFrom = (
  endpoint: string,
  connections: readonly ConnectionView[],
  apps: readonly App[],
): readonly Connection[] => {
  const byId = new Map<AppId, App>(apps.map((app) => [app.id, app]));
  return [
    {
      id: "default",
      name: "Full access",
      url: endpoint,
      full: true,
      apps: apps.map((app) => ({ app, name: app.name })),
    },
    ...connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      url: connection.url,
      full: false,
      apps: connection.policy.apps.map((item) => {
        const app = byId.get(item.app);
        return { app, name: app?.name ?? "Unavailable app" };
      }),
    })),
  ];
};

export function ConnectionsPage() {
  const inventory = useQuery(overviewAtom);
  const connections = useQuery(mcpConnectionsAtom);
  const installation = useQuery(mcpInstallationAtom);
  const [connecting, setConnecting] = useState<Connection>();
  if (
    Option.isNone(inventory.data) ||
    Option.isNone(connections.data) ||
    Option.isNone(installation.data)
  )
    return (
      <PageFrame>
        <LoadingRows count={4} />
      </PageFrame>
    );
  const items = connectionsFrom(
    installation.data.value.endpoint,
    connections.data.value,
    inventory.data.value.apps,
  );
  return (
    <PageFrame>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.035em]">Connections</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Each connection gives an agent its own MCP URL that reaches only the apps you pick.
          </p>
        </div>
        <Button asChild>
          <Link to="/connections/$connectionId" params={{ connectionId: "new" }}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
            New connection
          </Link>
        </Button>
      </header>
      <div className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1">
        {items.map((item) => (
          <ConnectionCard key={item.id} connection={item} onConnect={setConnecting} />
        ))}
      </div>
      <ConnectDialog
        target={
          connecting === undefined
            ? undefined
            : {
                name: connecting.name,
                url: connecting.url,
                apps: connecting.full ? undefined : connecting.apps.map((app) => app.name),
              }
        }
        onClose={() => setConnecting(undefined)}
      />
    </PageFrame>
  );
}

/** What the Connect dialog needs; `apps` is undefined for the full-access URL. */
export interface ConnectTarget {
  readonly name: string;
  readonly url: string;
  readonly apps: readonly string[] | undefined;
}

export function ConnectDialog({
  target,
  onClose,
}: {
  readonly target: ConnectTarget | undefined;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect {target?.name}</DialogTitle>
          <DialogDescription>
            {target?.apps === undefined
              ? "This URL reaches every app. Make a new connection to limit what an agent sees."
              : `This URL only reaches ${target.apps.join(", ")}.`}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <McpInstallInstructions
            endpoint={target.url}
            {...(target.apps === undefined
              ? {}
              : { next: "show me which apps and tools this connection can use" })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AppIcon({ item }: { readonly item: ConnectionApp }) {
  const provider =
    item.app === undefined
      ? undefined
      : Object.values(item.app.requirements.accounts)[0]?.definition;
  return <ProviderIcon name={provider?.name ?? item.name} url={providerDisplayUrl(provider)} />;
}

/** Scoped cards open their page; the stretched name link keeps Connect a separate button. */
function ConnectionCard({
  connection,
  onConnect,
}: {
  readonly connection: Connection;
  readonly onConnect: (connection: Connection) => void;
}) {
  const shown = connection.apps.slice(0, 4);
  return (
    <div className="relative flex min-h-56 flex-col max-[600px]:min-h-0 rounded-xl border border-border p-4 transition-colors has-[a:hover]:border-muted-foreground/40 has-[a:hover]:bg-muted/60 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <span className="flex items-center gap-2">
        {connection.full ? (
          <span className="text-[14px] font-medium">{connection.name}</span>
        ) : (
          <Link
            to="/connections/$connectionId"
            params={{ connectionId: connection.id }}
            className="text-[14px] font-medium after:absolute after:inset-0 after:rounded-xl"
          >
            {connection.name}
          </Link>
        )}
        {connection.full && (
          <span className="rounded-md border border-border px-1.5 py-px text-[11px] text-muted-foreground">
            Default
          </span>
        )}
      </span>
      <ul className="mt-4 grid gap-1.5">
        {shown.map((item) => (
          <li
            key={item.name}
            className="flex items-center gap-2 text-[13px] [&_.provider-icon]:size-5 [&_.provider-icon]:rounded-[5px] [&_.provider-icon_img]:size-3"
          >
            <AppIcon item={item} />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
          </li>
        ))}
        {connection.apps.length > shown.length && (
          <li className="pl-7 text-[12px] text-muted-foreground">
            and {connection.apps.length - shown.length} more
          </li>
        )}
      </ul>
      <div className="relative z-10 mt-auto pt-4">
        <Button size="sm" variant="outline" onClick={() => onConnect(connection)}>
          <HugeiconsIcon icon={ConnectIcon} strokeWidth={2} aria-hidden />
          Connect
        </Button>
      </div>
    </div>
  );
}
