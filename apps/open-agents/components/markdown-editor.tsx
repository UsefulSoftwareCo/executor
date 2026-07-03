"use client";

import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { cn } from "@/lib/utils";

export function MarkdownEditor({
  value,
  onChange,
  placeholder = "Write markdown...",
  minHeightClassName = "min-h-72",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeightClassName?: string;
}) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: value,
    contentType: "markdown",
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm max-w-none break-words focus:outline-none dark:prose-invert [overflow-wrap:anywhere]",
          minHeightClassName,
          "px-3 py-2",
        ),
        "aria-label": placeholder,
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getMarkdown());
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    const current = editor.getMarkdown();
    if (current !== value) {
      editor.commands.setContent(value, { contentType: "markdown" });
    }
  }, [editor, value]);

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-input bg-background shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      <EditorContent
        editor={editor}
        className="max-h-[34rem] min-w-0 overflow-y-auto overflow-x-hidden break-words [&_.ProseMirror>*+*]:mt-3 [&_.ProseMirror_code]:break-words [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_pre]:whitespace-pre-wrap [&_.ProseMirror_pre]:break-words [&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:bg-muted [&_.ProseMirror_pre]:p-3"
      />
    </div>
  );
}
