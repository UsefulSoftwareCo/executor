import { AutomationsShell } from "./automations-shell";

type PageProps = {
  searchParams?: Promise<{ sessionId?: string | string[] }>;
};

export default async function AutomationsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawSessionId = params?.sessionId;
  const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  return <AutomationsShell attachedSessionId={sessionId ?? null} />;
}
