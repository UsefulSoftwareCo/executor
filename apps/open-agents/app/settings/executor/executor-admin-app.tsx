"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { CredentialsPage } from "@executor-js/react/pages/credentials";
import { AddIntegrationPage } from "@executor-js/react/pages/integration-add";
import { IntegrationDetailPage } from "@executor-js/react/pages/integration-detail";
import { IntegrationsPage } from "@executor-js/react/pages/integrations";
import { PoliciesPage } from "@executor-js/react/pages/policies";
import { ToolsPage } from "@executor-js/react/pages/tools";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import openApiClientPlugin from "@executor-js/plugin-openapi/client";
import createMcpClientPlugin from "@executor-js/plugin-mcp/client";
import graphqlClientPlugin from "@executor-js/plugin-graphql/client";
import { cn } from "@/lib/utils";

type ExecutorRoute =
  | { kind: "integrations" }
  | { kind: "tools" }
  | { kind: "credentials" }
  | { kind: "policies" }
  | { kind: "integration-detail"; namespace: string }
  | { kind: "integration-add"; pluginKey: string }
  | { kind: "not-found" };

function executorHref(basePath: string, path: string) {
  return path === "/" ? basePath : `${basePath}${path}`;
}

function resolveExecutorRoute(pathname: string, basePath: string): ExecutorRoute {
  const relativePath = pathname === basePath ? "/" : pathname.slice(basePath.length);
  const segments = relativePath.split("/").filter(Boolean);
  const [section, action, value] = segments;

  if (segments.length === 0) return { kind: "integrations" };
  if (segments.length === 1 && section === "tools") return { kind: "tools" };
  if (segments.length === 1 && section === "credentials") return { kind: "credentials" };
  if (segments.length === 1 && section === "policies") return { kind: "policies" };
  if (section === "integrations" && action === "add" && value && segments.length === 3) {
    return { kind: "integration-add", pluginKey: decodeURIComponent(value) };
  }
  if (section === "integrations" && action && segments.length === 2) {
    return { kind: "integration-detail", namespace: decodeURIComponent(action) };
  }
  return { kind: "not-found" };
}

function ExecutorAdminShell({
  basePath,
  route,
  children,
}: {
  basePath: string;
  route: ExecutorRoute;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[640px] flex-col overflow-hidden rounded-md border border-border bg-background">
      <nav className="flex shrink-0 gap-1 border-b border-border bg-muted/20 px-3 py-2">
        <ExecutorNavLink
          active={
            route.kind === "integrations" ||
            route.kind === "integration-detail" ||
            route.kind === "integration-add"
          }
          href={executorHref(basePath, "/")}
          label="Integrations"
        />
        <ExecutorNavLink
          active={route.kind === "tools"}
          href={executorHref(basePath, "/tools")}
          label="Tools"
        />
        <ExecutorNavLink
          active={route.kind === "credentials"}
          href={executorHref(basePath, "/credentials")}
          label="Credentials"
        />
        <ExecutorNavLink
          active={route.kind === "policies"}
          href={executorHref(basePath, "/policies")}
          label="Policies"
        />
      </nav>
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function ExecutorNavLink({
  active,
  href,
  label,
}: {
  active: boolean;
  href: string;
  label: string;
}) {
  return (
    <a
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        active && "bg-background text-foreground shadow-sm",
      )}
      href={href}
    >
      {label}
    </a>
  );
}

function ExecutorRouteNotFound() {
  return (
    <div className="p-6 text-sm text-muted-foreground" data-executor-admin-route-not-found>
      Executor route not found
    </div>
  );
}

function ExecutorAdminLoading() {
  return (
    <div
      className="min-h-[640px] rounded-md border border-dashed border-border bg-muted/20"
      data-executor-admin-loading
    />
  );
}

export function ExecutorAdminApp({
  apiBasePath,
  basePath,
}: {
  apiBasePath: string;
  basePath: string;
}) {
  const [browserRuntimeMounted, setBrowserRuntimeMounted] = useState(false);

  useEffect(() => {
    setBrowserRuntimeMounted(true);
  }, []);

  if (!browserRuntimeMounted) {
    return <ExecutorAdminLoading />;
  }

  return <ExecutorAdminBrowserRuntime apiBasePath={apiBasePath} basePath={basePath} />;
}

function ExecutorAdminBrowserRuntime({
  apiBasePath,
  basePath,
}: {
  apiBasePath: string;
  basePath: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const route = useMemo(() => resolveExecutorRoute(pathname, basePath), [pathname, basePath]);
  const clientPlugins = useMemo(
    () => [openApiClientPlugin, createMcpClientPlugin(), graphqlClientPlugin],
    [],
  );
  const connection = useMemo(
    () => ({
      kind: "http" as const,
      origin: window.location.origin,
      apiBaseUrl: `${window.location.origin}${apiBasePath}`,
    }),
    [apiBasePath],
  );

  const page =
    route.kind === "integrations" ? (
      <IntegrationsPage basePath={basePath} />
    ) : route.kind === "tools" ? (
      <ToolsPage basePath={basePath} />
    ) : route.kind === "credentials" ? (
      <CredentialsPage />
    ) : route.kind === "policies" ? (
      <PoliciesPage />
    ) : route.kind === "integration-detail" ? (
      <IntegrationDetailPage basePath={basePath} namespace={route.namespace} />
    ) : route.kind === "integration-add" ? (
      <AddIntegrationPage
        basePath={basePath}
        namespace={searchParams.get("namespace") ?? undefined}
        pluginKey={route.pluginKey}
        preset={searchParams.get("preset") ?? undefined}
        url={searchParams.get("url") ?? undefined}
      />
    ) : (
      <ExecutorRouteNotFound />
    );

  return (
    <ExecutorProvider connection={connection}>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        <ExecutorAdminShell basePath={basePath} route={route}>
          {page}
        </ExecutorAdminShell>
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}
