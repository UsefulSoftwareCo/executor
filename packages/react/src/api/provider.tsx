import { RegistryProvider } from "@effect/atom-react";
import * as React from "react";
import { FrontendErrorReporterProvider, type FrontendErrorReporter } from "./error-reporting";
import { ScopeProvider } from "./scope-context";

export const ExecutorProvider = (
  props: React.PropsWithChildren<{
    fallback?: React.ReactNode;
    onHandledError?: FrontendErrorReporter;
  }>,
) => (
  <FrontendErrorReporterProvider reporter={props.onHandledError}>
    <RegistryProvider>
      <ScopeProvider fallback={props.fallback}>{props.children}</ScopeProvider>
    </RegistryProvider>
  </FrontendErrorReporterProvider>
);
