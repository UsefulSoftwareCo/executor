import { RegistryProvider } from "@effect/atom-react";
import * as React from "react";

import { FrontendErrorReporterProvider, type FrontendErrorReporter } from "./error-reporting";
import {
  ExecutorServerConnectionProvider,
  useExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "./server-connection";

function ExecutorRegistryProvider(props: React.PropsWithChildren) {
  const connection = useExecutorServerConnection();
  return <RegistryProvider key={connection.key}>{props.children}</RegistryProvider>;
}

export const ExecutorProvider = (
  props: React.PropsWithChildren<{
    connection?: ExecutorServerConnectionInput;
    onHandledError?: FrontendErrorReporter;
  }>,
) => (
  <FrontendErrorReporterProvider reporter={props.onHandledError}>
    <ExecutorServerConnectionProvider connection={props.connection}>
      <ExecutorRegistryProvider>{props.children}</ExecutorRegistryProvider>
    </ExecutorServerConnectionProvider>
  </FrontendErrorReporterProvider>
);
