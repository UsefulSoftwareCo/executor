import { ExecutorAdminApp } from "@/app/settings/executor/executor-admin-app";

type SessionExecutorPageProps = {
  params: Promise<{ sessionId: string; path?: string[] }>;
};

export default async function SessionExecutorPage({
  params,
}: SessionExecutorPageProps) {
  const { sessionId } = await params;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
      <div>
        <h1 className="text-lg font-semibold">Session Tools</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure sources and policies for this session.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <ExecutorAdminApp
          apiBasePath={`/api/executor/session/${encodeURIComponent(sessionId)}`}
          basePath={`/sessions/${encodeURIComponent(sessionId)}/executor`}
        />
      </div>
    </div>
  );
}
