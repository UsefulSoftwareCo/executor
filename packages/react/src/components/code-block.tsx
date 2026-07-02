import { useCallback, useMemo, useState, type ReactNode } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import {
  dualThemeOptions,
  getHighlighter,
  ensureLang,
  resolveLang,
  type ShikiThemeProp,
} from "../lib/shiki";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { copyToClipboard } from "../lib/clipboard";
import { Button } from "./button";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(code: string, hint?: string): string {
  if (hint) return resolveLang(hint) ?? "json";
  const trimmed = code.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<")) return "xml";
  if (trimmed.startsWith("---")) return "yaml";
  return "json";
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const CopyIcon = () => (
  <svg viewBox="0 0 16 16" className="size-3">
    <rect
      x="5"
      y="5"
      width="8"
      height="8"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path d="M3 11V3h8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" className="size-3">
    <path
      d="M3 8l3 3 7-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// ---------------------------------------------------------------------------
// Highlight hook
// ---------------------------------------------------------------------------

function useHighlighted(code: string, lang: string, theme?: ShikiThemeProp): ReactNode | null {
  const [, setTick] = useState(0);
  const resolvedLang = (resolveLang(lang) ?? "json") as Parameters<typeof ensureLang>[0];

  const isReady = ensureLang(resolvedLang, () => setTick((t) => t + 1));

  if (!isReady) return null;

  const highlighter = getHighlighter();
  // Dual-theme light-dark() colors: the markup is correct in BOTH color
  // schemes, so SSR/hydration can't paint the wrong palette first.
  const hast = highlighter.codeToHast(code, { lang: resolvedLang, ...dualThemeOptions(theme) });
  return toJsxRuntime(hast, { jsx, jsxs, Fragment });
}

// ---------------------------------------------------------------------------
// CodeBlock
// ---------------------------------------------------------------------------

export function CodeBlock(props: {
  code: string;
  lang?: string;
  title?: string;
  maxHeight?: string;
  className?: string;
  theme?: ShikiThemeProp;
  /** Fires after a successful copy. Receives nothing — the code may be sensitive. */
  onCopy?: () => void;
}) {
  const { code, lang: langHint, title, className, theme, onCopy } = props;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const language = useMemo(() => detectLanguage(code, langHint), [code, langHint]);
  const highlighted = useHighlighted(code, language, theme);

  const lines = code.split("\n");
  const isLong = lines.length > 24;
  const maxH = !expanded && isLong ? (props.maxHeight ?? "24rem") : undefined;

  const handleCopy = useCallback(() => {
    void copyToClipboard(code).then((ok) => {
      if (!ok) {
        toast.error("Failed to copy to clipboard");
        return;
      }
      setCopied(true);
      onCopy?.();
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code, onCopy]);

  return (
    <div className={cn("rounded-lg border border-border bg-card/60 overflow-hidden", className)}>
      {title && (
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            className="text-muted-foreground hover:text-muted-foreground"
            title="Copy"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
      )}
      <div className="group relative">
        {!title && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 p-1.5 text-muted-foreground opacity-0 backdrop-blur-sm hover:text-foreground group-hover:opacity-100 transition-opacity"
            title="Copy to clipboard"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}

        <div
          className={cn(
            "text-sm leading-relaxed [&_pre]:!bg-transparent [&_pre]:p-3 [&_code]:font-mono",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            maxH ? "overflow-auto" : "overflow-x-auto overflow-y-hidden",
          )}
          style={maxH ? { maxHeight: maxH } : undefined}
        >
          {highlighted ?? (
            <pre className="p-3 font-mono text-sm leading-relaxed text-foreground/60">{code}</pre>
          )}
        </div>

        {isLong && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 flex justify-center bg-gradient-to-t from-card/90 to-transparent pb-2 pt-8">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExpanded(true)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Show all ({lines.length} lines)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
