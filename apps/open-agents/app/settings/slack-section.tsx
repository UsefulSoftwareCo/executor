"use client";

import { Loader2, MessageSquareText, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { fetcher } from "@/lib/swr";

type SlackLink = {
  slackTeamId: string;
  slackUserId: string;
  slackUserName: string | null;
  updatedAt: string;
};

type SlackLinkResponse = {
  link: SlackLink | null;
};

export function SlackSectionSkeleton() {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/10">
      <div className="border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <MessageSquareText className="h-5 w-5" />
          <span className="text-sm font-medium">Slack</span>
        </div>
        <Skeleton className="mt-2 h-3.5 w-72" />
      </div>
      <div className="space-y-3 p-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}

export function SlackSection() {
  const { data, isLoading, mutate } = useSWR<SlackLinkResponse>(
    "/api/settings/slack-link",
    fetcher,
  );
  const [slackUserId, setSlackUserId] = useState("");
  const [slackTeamId, setSlackTeamId] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setSlackUserId(data?.link?.slackUserId ?? "");
    setSlackTeamId(data?.link?.slackTeamId === "default" ? "" : (data?.link?.slackTeamId ?? ""));
  }, [data?.link?.slackTeamId, data?.link?.slackUserId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/settings/slack-link", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slackUserId, slackTeamId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? "Failed to save Slack link");
      }
      await mutate();
      toast.success("Slack account linked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Slack link");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const response = await fetch("/api/settings/slack-link", {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to unlink Slack account");
      }
      await mutate();
      toast.success("Slack account unlinked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unlink Slack account");
    } finally {
      setDeleting(false);
    }
  }

  if (isLoading) {
    return <SlackSectionSkeleton />;
  }

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10">
      <div className="border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <MessageSquareText className="h-5 w-5" />
          <span className="text-sm font-medium">Slack</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Link your Slack identity so Slack bot conversations run as your Open Agents account.
        </p>
      </div>

      <form className="space-y-4 p-4" onSubmit={handleSubmit}>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="slack-user-id">Slack user ID</Label>
            <Input
              id="slack-user-id"
              placeholder="U012ABCDEF"
              value={slackUserId}
              onChange={(event) => setSlackUserId(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="slack-team-id">Slack team ID</Label>
            <Input
              id="slack-team-id"
              placeholder="Optional for this workspace"
              value={slackTeamId}
              onChange={(event) => setSlackTeamId(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={saving || !slackUserId.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>
            Mention the bot before linking and it will reply with the Slack user ID it sees.
          </p>
          {data?.link ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 gap-1 text-xs"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              Unlink
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
