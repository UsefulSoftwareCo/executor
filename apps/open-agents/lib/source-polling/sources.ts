import { isSourcePollingGloballyEnabled } from "@/lib/source-polling/config";

export type SourcePollingResult = {
  source: string;
  processed: number;
  skipped: number;
  cursor?: string;
  errors?: string[];
};

export type SourcePollingSource = {
  name: string;
  poll: () => Promise<SourcePollingResult>;
};

export async function getEnabledPollingSources(): Promise<
  SourcePollingSource[]
> {
  if (!isSourcePollingGloballyEnabled()) {
    return [];
  }

  return [];
}

export async function pollEnabledSources(): Promise<SourcePollingResult[]> {
  await getEnabledPollingSources();
  return [];
}
