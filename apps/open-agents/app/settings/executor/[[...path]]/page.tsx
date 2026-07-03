import { ExecutorAdminClient } from "../executor-admin-client";

export default function ExecutorSettingsPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Executor</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure integrations, credentials, policies, and tools available to OpenAgents.
        </p>
      </div>
      <ExecutorAdminClient apiBasePath="/api/executor" basePath="/settings/executor" />
    </>
  );
}
