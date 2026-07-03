"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type {
  AgentDefinition,
  AgentEditorInput,
  AgentLibrarySaveScope,
  AgentLibrarySummary,
  SkillDocument,
  SkillEditorInput,
} from "@/lib/agents/definitions";

interface AgentLibraryResponse {
  library: AgentLibrarySummary;
}

async function readJsonError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? "Agent library request failed";
}

export function useAgentLibrary() {
  const { data, error, isLoading, mutate } = useSWR<AgentLibraryResponse>(
    "/api/settings/agent-library",
    fetcher,
  );

  const saveAgent = async (
    item: AgentEditorInput,
    options?: { setDefault?: boolean; scope?: AgentLibrarySaveScope },
  ): Promise<AgentDefinition> => {
    const response = await fetch("/api/settings/agent-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "agent",
        item,
        setDefault: options?.setDefault ?? false,
        scope: options?.scope ?? "user",
      }),
    });

    if (!response.ok) {
      throw new Error(await readJsonError(response));
    }

    const next = (await response.json()) as AgentLibraryResponse & {
      item: AgentDefinition;
    };
    await mutate({ library: next.library }, { revalidate: false });
    return next.item;
  };

  const saveSkill = async (
    item: SkillEditorInput,
    options?: { scope?: AgentLibrarySaveScope },
  ): Promise<SkillDocument> => {
    const response = await fetch("/api/settings/agent-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "skill", item, scope: options?.scope ?? "user" }),
    });

    if (!response.ok) {
      throw new Error(await readJsonError(response));
    }

    const next = (await response.json()) as AgentLibraryResponse & {
      item: SkillDocument;
    };
    await mutate({ library: next.library }, { revalidate: false });
    return next.item;
  };

  const deleteItem = async (
    kind: "agent" | "skill",
    id: string,
    scope: AgentLibrarySaveScope,
  ) => {
    const response = await fetch(
      `/api/settings/agent-library?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}&scope=${encodeURIComponent(scope)}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      throw new Error(await readJsonError(response));
    }

    const next = (await response.json()) as AgentLibraryResponse;
    await mutate({ library: next.library }, { revalidate: false });
  };

  const setDefaultAgent = async (defaultAgentName: string | null) => {
    const response = await fetch("/api/settings/agent-library", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAgentName }),
    });

    if (!response.ok) {
      throw new Error(await readJsonError(response));
    }

    const next = (await response.json()) as AgentLibraryResponse;
    await mutate({ library: next.library }, { revalidate: false });
  };

  return {
    library: data?.library,
    loading: isLoading,
    error: error?.message ?? null,
    saveAgent,
    saveSkill,
    deleteItem,
    setDefaultAgent,
    refreshLibrary: mutate,
  };
}
