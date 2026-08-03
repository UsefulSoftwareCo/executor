import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@executor-js/react/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor-js/react/components/collapsible";
import { FieldLabel } from "@executor-js/react/components/field";
import { Textarea } from "@executor-js/react/components/textarea";

import { parseSpecOverridesText } from "../sdk/spec-overrides";

export function SpecOverridesEditor(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(props.value.trim().length > 0);
  const parsed = parseSpecOverridesText(props.value);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        Spec overrides
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 space-y-2">
          <FieldLabel>JSON Patch (RFC 6902)</FieldLabel>
          <Textarea
            value={props.value}
            onChange={(event) => props.onChange((event.target as HTMLTextAreaElement).value)}
            placeholder={'[{"op":"replace","path":"/info/title","value":"My API"}]'}
            rows={5}
            maxRows={14}
            className="font-mono text-xs"
            disabled={props.disabled}
            aria-invalid={!parsed.ok}
          />
          {!parsed.ok && <p className="text-xs text-destructive">{parsed.message}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
