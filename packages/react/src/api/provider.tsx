import { RegistryProvider } from "@effect/atom-react";
import * as React from "react";

import { FrontendErrorReporterProvider, type FrontendErrorReporter } from "./error-reporting";
import {
  ExecutorServerConnectionProvider,
  setActiveOrgSlugOverride,
  useExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "./server-connection";

function ExecutorRegistryProvider(props: React.PropsWithChildren<{ scopeKey?: string | null }>) {
  const connection = useExecutorServerConnection();
  // The org scope MUST be part of the registry key on org-scoped hosts: query
  // atoms key their cache entries on the request shape alone (the org selector
  // header is injected in transformClient, invisible to the atom family key),
  // so without it a cached result fetched under one org would serve under
  // another for its TTL. Keying the registry tears the whole cache down
  // whenever the scope changes — including bare-URL → slugged canonicalization,
  // which discards any header-less (server-rejected) fetches from first paint.
  //
  // The scope also becomes the header authority (setActiveOrgSlugOverride) —
  // synchronously, during render, BEFORE the keyed registry below mounts and
  // its atoms fire their first fetches. window.history lags the router during
  // client-side navigations, so deriving the header from window.location alone
  // would scope those first fetches to the OLD URL. Browser only: the header
  // injection never runs during SSR, and the worker's module state is shared
  // across concurrent requests.
  if (props.scopeKey !== undefined && globalThis.window) {
    setActiveOrgSlugOverride(props.scopeKey);
  }
  const key = props.scopeKey ? `${connection.key}#${props.scopeKey}` : connection.key;
  return <RegistryProvider key={key}>{props.children}</RegistryProvider>;
}

export const ExecutorProvider = (
  props: React.PropsWithChildren<{
    connection?: ExecutorServerConnectionInput;
    /**
     * The org scope the atom registry is keyed to — pass the console URL's org
     * slug on org-scoped hosts (cloud) so cached query results can never
     * survive an org change. Hosts without org scoping leave it unset.
     */
    scopeKey?: string | null;
    onHandledError?: FrontendErrorReporter;
  }>,
) => (
  <FrontendErrorReporterProvider reporter={props.onHandledError}>
    <ExecutorServerConnectionProvider connection={props.connection}>
      <ExecutorRegistryProvider scopeKey={props.scopeKey}>
        {props.children}
      </ExecutorRegistryProvider>
    </ExecutorServerConnectionProvider>
  </FrontendErrorReporterProvider>
);
