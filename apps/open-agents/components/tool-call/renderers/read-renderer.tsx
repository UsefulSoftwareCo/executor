"use client";

import { toRelativePath } from "@open-agents/shared/lib/tool-state";
import { FileText } from "lucide-react";
import { File as DiffsFile } from "@pierre/diffs/react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { defaultFileOptions } from "@/lib/diffs-config";
import type { BaseCodeOptions } from "@pierre/diffs/react";
import { ToolLayout } from "../tool-layout";
import { FileNamePill } from "../file-name-pill";

const partialReadFileOptions: BaseCodeOptions = {
  ...defaultFileOptions,
  disableLineNumbers: true,
};

export function ReadRenderer({
  part,
  state,
  cwd = "",
  onApprove,
  onDeny,
}: ToolRendererProps<"tool-read_file">) {
  const input = part.input;
  const rawFilePath = input?.filePath ?? "...";
  const filePath =
    rawFilePath === "..." ? rawFilePath : toRelativePath(rawFilePath, cwd);

  const output =
    part.state === "output-available" && !("error" in part.output)
      ? part.output
      : undefined;
  const totalLines = output?.totalLines;
  const startLine = input?.offset ?? 1;
  const endLine = output?.nextOffset ? output.nextOffset - 1 : totalLines;
  const fileContent = output?.content;
  const isPartialRead =
    startLine !== undefined &&
    endLine !== undefined &&
    totalLines !== undefined &&
    (startLine > 1 || endLine < totalLines);
  const outputError =
    part.state === "output-available" && "error" in part.output
      ? part.output.error
      : undefined;

  const mergedState = outputError
    ? { ...state, error: state.error ?? outputError }
    : state;

  // Strip line number prefixes ("N: ") from content for the code viewer
  const cleanContent = fileContent
    ? fileContent
        .split("\n")
        .map((line) => line.replace(/^\d+: /, ""))
        .join("\n")
    : undefined;

  const fileOptions = isPartialRead
    ? partialReadFileOptions
    : defaultFileOptions;

  const expandedContent = cleanContent ? (
    <div className="max-h-96 overflow-auto rounded-md border border-border">
      <DiffsFile
        file={{ name: rawFilePath, contents: cleanContent }}
        options={fileOptions}
      />
    </div>
  ) : undefined;

  const meta = isPartialRead
    ? `[${startLine}–${endLine}]`
    : totalLines !== undefined
      ? `${totalLines} lines`
      : undefined;

  return (
    <ToolLayout
      name="Read"
      icon={<FileText className="h-3.5 w-3.5" />}
      summary={
        filePath === "..." ? (
          filePath
        ) : (
          <FileNamePill
            filePath={filePath}
            fullPath={rawFilePath}
            error={Boolean(mergedState.error)}
          />
        )
      }
      meta={meta}
      errorMeta={mergedState.error ? "failed" : undefined}
      state={mergedState}
      expandedContent={expandedContent}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
