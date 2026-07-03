"use client";

import { MessageCircleQuestion } from "lucide-react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { ToolLayout } from "../tool-layout";

export function AskUserQuestionRenderer({
  part,
  state,
}: ToolRendererProps<"tool-ask_question">) {
  const input = part.input;
  const output = part.state === "output-available" ? part.output : undefined;
  const options = input?.options ?? [];

  const isWaitingForInput =
    part.state === "input-available" || part.state === "approval-requested";
  const isStreaming = part.state === "input-streaming";
  const hasOutput = part.state === "output-available";
  const isIgnored =
    hasOutput && output && "status" in output && output.status === "ignored";
  const isAnswered =
    hasOutput && output && "status" in output && output.status === "answered";

  const summary = isStreaming
    ? "Generating question"
    : isWaitingForInput
      ? "Waiting for user input"
      : isIgnored
        ? "Ignored"
        : isAnswered
          ? "Answered"
          : state.denied
            ? "Cancelled"
            : "Question";

  const questionCount = options.length;
  const meta =
    questionCount > 0
      ? `${questionCount} option${questionCount === 1 ? "" : "s"}`
      : undefined;

  const expandedContent =
    isAnswered && output && "status" in output ? (
      <div className="space-y-2">
        <p className="text-sm text-foreground">{input?.prompt}</p>
        <p className="text-sm text-muted-foreground">
          <span className="text-green-500">&rarr;</span>{" "}
          {output.text ?? output.optionId ?? "(not answered)"}
        </p>
      </div>
    ) : undefined;

  const displayState = isWaitingForInput
    ? { ...state, interrupted: false }
    : state;

  return (
    <ToolLayout
      name="Ask user"
      summary={summary}
      meta={meta}
      state={displayState}
      icon={<MessageCircleQuestion className="h-3.5 w-3.5" />}
      nameClassName={state.denied || isIgnored ? "text-red-500" : undefined}
      expandedContent={expandedContent}
      defaultExpanded={false}
    />
  );
}
