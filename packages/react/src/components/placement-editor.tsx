import { PlusIcon, XIcon } from "lucide-react";

import {
  emptyPlacement,
  PlacementLine,
  type Carrier,
  type Placement,
} from "../lib/auth-placements";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

// ---------------------------------------------------------------------------
// Placement editor — compact cards for where an API key is sent.
//
// Each card uses a segmented Header/Query choice, labeled name/prefix fields,
// and an inline preview of the rendered credential placement.
// ---------------------------------------------------------------------------

const PLACEMENT_PRESETS: readonly {
  readonly label: string;
  readonly placements: readonly Placement[];
}[] = [
  {
    label: "Bearer header",
    placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
  },
  {
    label: "API key header",
    placements: [{ carrier: "header", name: "X-API-Key", prefix: "" }],
  },
  {
    label: "API key query",
    placements: [{ carrier: "query", name: "api_key", prefix: "" }],
  },
];

export function PlacementEditor(props: {
  readonly placements: readonly Placement[];
  readonly onChange: (placements: Placement[]) => void;
}) {
  const { placements, onChange } = props;

  const set = (index: number, patch: Partial<Placement>): void =>
    onChange(placements.map((p: Placement, j: number) => (j === index ? { ...p, ...patch } : p)));

  const remove = (index: number): void =>
    onChange(placements.filter((_p: Placement, j: number) => j !== index));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {PLACEMENT_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-full px-2.5 text-xs"
            onClick={() => onChange(preset.placements.map((placement) => ({ ...placement })))}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      {placements.map((placement: Placement, index: number) => (
        <div
          key={index}
          className="rounded-md border border-border/70 bg-background p-3.5 shadow-xs"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-xs text-muted-foreground">
              Send the value in a request header or query string.
            </p>
            {placements.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove location"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => remove(index)}
              >
                <XIcon />
              </Button>
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-1 rounded-md border border-border/60 bg-muted/30 p-1">
            {(["header", "query"] as const).map((carrier: Carrier) => (
              <Button
                key={carrier}
                type="button"
                variant={placement.carrier === carrier ? "secondary" : "ghost"}
                size="sm"
                className="h-8 rounded-sm text-xs"
                onClick={() => set(index, { carrier })}
              >
                {carrier === "header" ? "Header" : "Query param"}
              </Button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label
                htmlFor={`placement-name-${index}`}
                className="text-xs font-medium text-muted-foreground"
              >
                {placement.carrier === "header" ? "Header name" : "Query parameter"}
              </Label>
              <Input
                id={`placement-name-${index}`}
                className="h-9"
                placeholder={placement.carrier === "header" ? "Authorization" : "api_key"}
                value={placement.name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  set(index, { name: e.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor={`placement-prefix-${index}`}
                className="text-xs font-medium text-muted-foreground"
              >
                Prefix
              </Label>
              <Input
                id={`placement-prefix-${index}`}
                className="h-9"
                placeholder="Bearer "
                value={placement.prefix}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  set(index, { prefix: e.target.value })
                }
              />
            </div>
          </div>

          {placement.name ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
              <span>Preview</span>
              <PlacementLine placement={placement} />
            </div>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit border-dashed"
        onClick={() => onChange([...placements, emptyPlacement()])}
      >
        <PlusIcon />
        Add location
      </Button>
    </div>
  );
}
