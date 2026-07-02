import * as React from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Badge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";

// ---------------------------------------------------------------------------
// TagInput — type a value and click + (or press Enter) to add it; the added
// values stack as removable chips BELOW the input. The × removes one,
// Backspace on an empty field removes the last, and pasting a separated list
// adds them all. Values are de-duplicated and order-preserving. Used e.g. to
// declare the env var NAMES a stdio MCP server needs.
// ---------------------------------------------------------------------------

export function TagInput(props: {
  readonly values: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly placeholder?: string;
  readonly className?: string;
  /** Split pattern for a committed token / paste. Defaults to runs of
   *  whitespace and commas. */
  readonly separator?: RegExp;
}) {
  const { values, onChange } = props;
  const [draft, setDraft] = React.useState("");
  const separator = props.separator ?? /[\s,]+/;

  const commit = (raw: string) => {
    const tokens = raw
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const next = [...values];
    for (const token of tokens) if (!next.includes(token)) next.push(token);
    onChange(next);
    setDraft("");
  };

  return (
    <div className={cn("space-y-2", props.className)}>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (separator.test(text)) {
              e.preventDefault();
              commit(text);
            }
          }}
          // Don't lose a typed-but-unsubmitted value when focus leaves (e.g. the
          // user clicks the form's submit instead of + / Enter).
          onBlur={() => commit(draft)}
          placeholder={props.placeholder}
          className="flex-1 font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Add"
          disabled={draft.trim().length === 0}
          onClick={() => commit(draft)}
        >
          <PlusIcon />
        </Button>
      </div>

      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <Badge key={value} variant="secondary" className="gap-0.5 py-0.5 pr-1 font-mono">
              {value}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${value}`}
                className="size-4 rounded-full hover:bg-transparent hover:text-foreground"
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                <XIcon />
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
