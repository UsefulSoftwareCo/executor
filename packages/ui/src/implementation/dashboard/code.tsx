import { formattedCodeAtom, codeLanguage } from "../../contracts/code-format.ts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { highlightedAtom } from "../../contracts/highlight.ts";
import { Button, type ButtonProps } from "../components/button.tsx";

/** Source headers and code blocks share the exact same formatting result. */
export function useFormattedCode(code: string, path: string): string {
  const atom = useMemo(() => formattedCodeAtom({ code, path }), [code, path]);
  const result = useAtomValue(atom);
  return AsyncResult.isSuccess(result) ? result.value : code;
}

/** Read-only code with selectable text and local syntax highlighting. */
export function Code({
  code,
  path = "schema.json",
  copyable = false,
  copyLabel = "Copy code",
}: {
  readonly code: string;
  readonly path?: string;
  readonly copyable?: boolean;
  readonly copyLabel?: string;
}) {
  const language = codeLanguage(path);
  const display = useFormattedCode(code, path);
  const atom = useMemo(() => highlightedAtom({ code: display, language }), [display, language]);
  const result = useAtomValue(atom);
  const view = (
    <pre
      className="code-view [.source-file_>_.code-block_>_&]:flex-1 [.code-toolbar_+_&]:pt-8.5 text-[11px] leading-[1.8] overflow-auto m-0 [padding:16px_16px_20px_0] [tab-size:2] bg-muted [.tool-detail_&]:border [.tool-detail_&]:border-border [.tool-detail_&]:rounded-[6px] [.tool-detail_&]:max-h-none [.mcp-install-code_&]:p-[20px] [.mcp-install-code_&]:text-[12px] [.mcp-install-code_&]:whitespace-pre-wrap [.mcp-install-code_&]:wrap-anywhere [.source-file_&]:flex-1"
      tabIndex={0}
    >
      <code>
        {AsyncResult.isSuccess(result)
          ? result.value.map((line, i) => (
              <span
                className="code-line inline [@media(prefers-color-scheme:_dark)]:[&_span[style]]:text-[color:var(--shiki-dark)]!"
                key={i}
              >
                <span
                  className="line-number inline-block text-muted-foreground opacity-65 min-w-10.75 pr-3.5 text-right select-none [.mcp-install-code_&]:hidden"
                  aria-hidden
                >
                  {i + 1}
                </span>
                <span>
                  {line.map((token, j) => (
                    <span key={j} style={token.htmlStyle}>
                      {token.content}
                    </span>
                  ))}
                </span>
                {"\n"}
              </span>
            ))
          : display.split("\n").map((line, i) => (
              <span
                className="code-line inline [@media(prefers-color-scheme:_dark)]:[&_span[style]]:text-[color:var(--shiki-dark)]!"
                key={i}
              >
                <span
                  className="line-number inline-block text-muted-foreground opacity-65 min-w-10.75 pr-3.5 text-right select-none [.mcp-install-code_&]:hidden"
                  aria-hidden
                >
                  {i + 1}
                </span>
                {line}
                {"\n"}
              </span>
            ))}
      </code>
    </pre>
  );
  return copyable ? (
    <div className="code-block relative [.source-file_>_&]:flex-1 [.source-file_>_&]:min-h-0 [.source-file_>_&]:flex [.source-file_>_&]:flex-col">
      <CopyButton code={display} label={copyLabel} />
      {view}
    </div>
  ) : (
    view
  );
}

/** Copy the raw value with local feedback; unknown values keep the control disabled. Clipboard contents never enter logs. */
export function CopyButton({
  code,
  label,
  inline = false,
  text = "Copy",
  variant = "ghost",
  size = "xs",
}: {
  readonly code: string | undefined;
  readonly label: string;
  readonly inline?: boolean;
  readonly text?: string;
  readonly variant?: ButtonProps["variant"];
  readonly size?: ButtonProps["size"];
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timeout = useRef<number | undefined>(undefined);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- reset feedback when the copied value changes
    setState("idle");
    return () => {
      if (timeout.current !== undefined) window.clearTimeout(timeout.current);
    };
  }, [code]);
  const copy = async () => {
    if (code === undefined) return;
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
      if (timeout.current !== undefined) window.clearTimeout(timeout.current);
      timeout.current = window.setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("failed");
    }
  };
  return (
    <div
      className={
        inline
          ? "code-toolbar copy-button-inline [.code-toolbar&]:static absolute z-1 top-1.5 right-1.5 [.oauth-redirect_>_&]:shrink-0"
          : "code-toolbar absolute z-1 top-1.5 right-1.5 [.oauth-redirect_>_&]:shrink-0"
      }
    >
      <Button
        type="button"
        disabled={code === undefined}
        variant={variant}
        size={size}
        onClick={() => void copy()}
        aria-label={label}
        aria-live="polite"
      >
        <HugeiconsIcon
          icon={state === "copied" ? Tick02Icon : Copy01Icon}
          strokeWidth={2}
          aria-hidden
          size={14}
        />
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : text}
      </Button>
    </div>
  );
}
