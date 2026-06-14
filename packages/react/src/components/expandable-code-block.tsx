import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { dualThemeOptions, getHighlighter, type ShikiThemeProp } from "../lib/shiki";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { copyToClipboard } from "../lib/clipboard";
import { Button } from "./button";
import type { ThemedToken } from "shiki/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Definition = {
  readonly name: string;
  /** The full type body string, e.g. `{ login: string; id: number }` */
  readonly code: string;
};

// ---------------------------------------------------------------------------
// Simple TypeScript formatter — expands single-line types into readable form
// ---------------------------------------------------------------------------

const formatTypeScript = (code: string): string => {
  let result = "";
  let indent = 0;
  let i = 0;
  const len = code.length;

  // Track brace depth so we only break `|` and `&` at the top level of a union
  let braceDepth = 0;

  while (i < len) {
    const ch = code[i]!;

    if (ch === "{") {
      braceDepth++;
      indent++;
      result += "{\n" + "  ".repeat(indent);
      i++;
      while (i < len && code[i] === " ") i++;
    } else if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      indent = Math.max(0, indent - 1);
      result += "\n" + "  ".repeat(indent) + "}";
      i++;
    } else if (ch === ";" && i + 1 < len && code[i + 1] === " ") {
      result += ";\n" + "  ".repeat(indent);
      i += 2;
    } else if (ch === ";" && indent > 0) {
      result += ";\n" + "  ".repeat(indent);
      i++;
      while (i < len && code[i] === " ") i++;
    } else if (ch === "|" && i > 0 && code[i - 1] === " " && i + 1 < len && code[i + 1] === " ") {
      // Union operator ` | ` — break onto new line
      result += "\n" + "  ".repeat(indent) + "| ";
      i += 2; // skip the operator and trailing space
    } else {
      result += ch;
      i++;
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Copy icons
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
// Shiki tokenization hook — non-blocking
// ---------------------------------------------------------------------------

function useTokens(code: string, theme?: ShikiThemeProp): ThemedToken[][] {
  const highlighter = getHighlighter();
  // Dual-theme light-dark() colors (token.htmlStyle): correct in both color
  // schemes from the first frame — no JS dark-mode probe to catch up to.
  const result = highlighter.codeToTokens(code, {
    lang: "typescript",
    ...dualThemeOptions(theme),
  });
  return result.tokens;
}

/** A dual-theme token's inline style (light-dark color + per-theme CSS vars). */
const tokenStyle = (token: Pick<ThemedToken, "color" | "htmlStyle">): CSSProperties | undefined =>
  (token.htmlStyle as CSSProperties | undefined) ??
  (token.color ? { color: token.color } : undefined);

// ---------------------------------------------------------------------------
// Inline-expand logic
//
// When a user clicks a ref name like `NonEmptyTrimmedString`, we replace
// that name with the resolved body inline. So `firstName: NonEmptyTrimmedString`
// becomes `firstName: string`.
//
// We rebuild the full code string with expansions applied, then re-tokenize.
// ---------------------------------------------------------------------------

/**
 * Given a code string, a set of ref names to expand, and their definitions,
 * produce a new code string with each expanded ref replaced by its body.
 * Applies recursively — if an expanded body itself contains expanded refs,
 * those get replaced too. Tracks ancestors to prevent infinite loops.
 */
const applyExpansions = (
  code: string,
  expanded: ReadonlySet<string>,
  definitions: ReadonlyMap<string, string>,
  ancestors: ReadonlySet<string>,
): string => {
  if (expanded.size === 0) return code;

  let result = "";
  let i = 0;

  // Sort expanded names longest-first to match greedily
  const sortedNames = [...expanded]
    .filter((n) => !ancestors.has(n))
    .sort((a, b) => b.length - a.length);

  while (i < code.length) {
    let matched = false;

    for (const name of sortedNames) {
      if (code.startsWith(name, i)) {
        const body = definitions.get(name);
        if (body) {
          // Recursively expand the body, adding this name to ancestors
          const childAncestors = new Set(ancestors);
          childAncestors.add(name);
          result += applyExpansions(body, expanded, definitions, childAncestors);
          i += name.length;
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      result += code[i];
      i++;
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Split tokens to find ref names that can be clicked
// ---------------------------------------------------------------------------

type RenderToken =
  | { kind: "text"; content: string; style?: CSSProperties }
  | { kind: "ref"; name: string; style?: CSSProperties };

const splitToken = (token: ThemedToken, clickableNames: ReadonlySet<string>): RenderToken[] => {
  const style = tokenStyle(token);
  if (clickableNames.size === 0) {
    return [{ kind: "text", content: token.content, style }];
  }

  const text = token.content;
  const results: RenderToken[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest = -1;
    let matchedName = "";
    for (const name of clickableNames) {
      const idx = remaining.indexOf(name);
      if (
        idx !== -1 &&
        (earliest === -1 ||
          idx < earliest ||
          (idx === earliest && name.length > matchedName.length))
      ) {
        earliest = idx;
        matchedName = name;
      }
    }

    if (earliest === -1) {
      results.push({ kind: "text", content: remaining, style });
      break;
    }

    if (earliest > 0) {
      results.push({ kind: "text", content: remaining.slice(0, earliest), style });
    }
    results.push({ kind: "ref", name: matchedName, style });
    remaining = remaining.slice(earliest + matchedName.length);
  }

  return results;
};

// ---------------------------------------------------------------------------
// HighlightedCode — renders tokenized code with clickable unexpanded refs
// ---------------------------------------------------------------------------

function HighlightedCode(props: {
  tokens: ThemedToken[][];
  /** Ref names that are NOT yet expanded and can be clicked */
  clickableNames: ReadonlySet<string>;
  onToggle: (name: string) => void;
  expanded: ReadonlySet<string>;
}) {
  const { tokens, clickableNames, onToggle, expanded } = props;

  return (
    <>
      {tokens.map((line, li) => (
        <span key={li}>
          {li > 0 && "\n"}
          {line.map((token, ti) => {
            const parts = splitToken(token, clickableNames);
            return parts.map((part, pi) => {
              if (part.kind === "text") {
                return (
                  <span key={`${ti}-${pi}`} style={part.style}>
                    {part.content}
                  </span>
                );
              }

              const isExpanded = expanded.has(part.name);

              return (
                <span
                  key={`${ti}-${pi}`}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(part.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onToggle(part.name);
                    }
                  }}
                  className={cn(
                    "cursor-pointer underline underline-offset-2 hover:opacity-80",
                    isExpanded ? "decoration-current/50" : "decoration-current/30",
                  )}
                  style={part.style}
                  title={isExpanded ? `Collapse ${part.name}` : `Expand ${part.name}`}
                >
                  {part.name}
                </span>
              );
            });
          })}
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// ExpandableCodeBlock — main export
// ---------------------------------------------------------------------------

export function ExpandableCodeBlock(props: {
  code: string;
  definitions?: readonly Definition[];
  className?: string;
  theme?: ShikiThemeProp;
}) {
  const { code, definitions = [], className, theme } = props;
  // Auto-expand trivial aliases (primitives, simple unions, string literals)
  const trivialNames = useMemo(() => {
    const trivial = new Set<string>();
    const trivialPattern =
      /^(?:string|number|boolean|null|undefined|void|never|unknown|any|true|false|(?:"[^"]*"(?:\s*\|\s*"[^"]*")*))$/;
    for (const d of definitions) {
      const body = d.code.trim();
      if (trivialPattern.test(body)) {
        trivial.add(d.name);
      }
    }
    return trivial;
  }, [definitions]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState(false);

  const definitionMap = useMemo(
    () => new Map(definitions.map((d) => [d.name, d.code])),
    [definitions],
  );

  const definitionNames = useMemo(() => new Set(definitions.map((d) => d.name)), [definitions]);

  // Names that can be clicked — exclude trivial aliases (already inlined)
  const clickableNames = useMemo(() => {
    const names = new Set(definitionNames);
    for (const name of trivialNames) names.delete(name);
    return names;
  }, [definitionNames, trivialNames]);

  const emptyAncestors = useMemo(() => new Set<string>(), []);

  // Merge user-expanded + trivial auto-expanded
  const allExpanded = useMemo(() => {
    const merged = new Set(expanded);
    for (const name of trivialNames) merged.add(name);
    return merged;
  }, [expanded, trivialNames]);

  // Build the display code: start with raw code, apply expansions, then format
  const displayCode = useMemo(() => {
    const withExpansions = applyExpansions(code, allExpanded, definitionMap, emptyAncestors);
    return formatTypeScript(withExpansions);
  }, [code, allExpanded, definitionMap, emptyAncestors]);

  const tokens = useTokens(displayCode, theme);

  const handleToggle = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const handleCopy = useCallback(() => {
    void copyToClipboard(displayCode).then((ok) => {
      if (!ok) {
        toast.error("Failed to copy to clipboard");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [displayCode]);

  return (
    <div className={cn("rounded-lg border border-border/40 bg-card/60 overflow-hidden", className)}>
      <div className="group relative">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleCopy}
          className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 p-1.5 text-muted-foreground opacity-0 backdrop-blur-sm hover:text-foreground group-hover:opacity-100 transition-opacity"
          title="Copy to clipboard"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>

        <pre className="overflow-auto p-3 font-mono text-xs leading-6 !bg-transparent">
          <code>
            <HighlightedCode
              tokens={tokens}
              clickableNames={clickableNames}
              onToggle={handleToggle}
              expanded={allExpanded}
            />
          </code>
        </pre>
      </div>
    </div>
  );
}
