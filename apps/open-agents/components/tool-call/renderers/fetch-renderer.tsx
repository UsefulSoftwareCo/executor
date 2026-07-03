"use client";

import { Globe } from "lucide-react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { ToolLayout } from "../tool-layout";

export function FetchRenderer({
  part,
  state,
  onApprove,
  onDeny,
}: ToolRendererProps<"tool-web_fetch">) {
  const input = part.input;
  const url = input?.url ?? "...";
  const format = input?.format ?? "markdown";

  const output = part.state === "output-available" ? part.output : undefined;
  const contentType = output && "contentType" in output ? output.contentType : undefined;
  const outputError =
    output && "error" in output ? (output.error ?? "Fetch failed") : undefined;

  const mergedState = outputError
    ? { ...state, error: state.error ?? outputError }
    : state;

  const displayUrl = url.length > 60 ? `${url.slice(0, 57)}...` : url;
  const summary = format === "markdown" ? displayUrl : `${format} ${displayUrl}`;

  const meta = contentType !== undefined ? contentType : undefined;

  return (
    <ToolLayout
      name="Fetch"
      icon={<Globe className="h-3.5 w-3.5" />}
      summary={summary}
      summaryClassName="font-mono"
      meta={meta}
      state={mergedState}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
