"use client";

import { ExecutorAdminApp } from "./executor-admin-app";

type ExecutorAdminClientProps = {
  apiBasePath: string;
  basePath: string;
};

export function ExecutorAdminClient({ apiBasePath, basePath }: ExecutorAdminClientProps) {
  return <ExecutorAdminApp apiBasePath={apiBasePath} basePath={basePath} />;
}
