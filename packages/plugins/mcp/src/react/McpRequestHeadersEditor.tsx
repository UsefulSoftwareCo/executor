import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FieldError } from "@executor-js/react/components/field";
import { Input } from "@executor-js/react/components/input";

import { emptyHeaderRow, isValidHeaderName, type McpHeaderRow } from "./request-headers";

// ---------------------------------------------------------------------------
// Request headers editor — the name/value pairs sent on every request to a
// remote MCP server, including the connection check.
//
// Deliberately plain: two mono fields and a remove control per row, matching
// the metadata voice the rest of the add flow uses. Rows are keyed by index
// because the values are fully controlled, exactly as the shared placement
// editor does it.
// ---------------------------------------------------------------------------

export function McpRequestHeadersEditor(props: {
  readonly rows: readonly McpHeaderRow[];
  readonly onChange: (rows: McpHeaderRow[]) => void;
  /** Re-run the connection check with the headers as typed. */
  readonly onTest?: () => void;
  readonly testing?: boolean;
}) {
  const { rows, onChange } = props;

  const set = (index: number, patch: Partial<McpHeaderRow>): void =>
    onChange(rows.map((row, j) => (j === index ? { ...row, ...patch } : row)));

  const remove = (index: number): void => onChange(rows.filter((_row, j) => j !== index));

  const hasInvalidName = rows.some((row) => !isValidHeaderName(row.name));

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntryField
          label="Request headers"
          description="- Optional. Sent on every request, including the connection check."
        >
          {rows.length > 0 && (
            <div className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label="Header name"
                    value={row.name}
                    onChange={(e) => set(index, { name: (e.target as HTMLInputElement).value })}
                    placeholder="CF-Access-Client-Id"
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                    aria-invalid={isValidHeaderName(row.name) ? undefined : true}
                  />
                  <Input
                    aria-label="Header value"
                    value={row.value}
                    onChange={(e) => set(index, { value: (e.target as HTMLInputElement).value })}
                    placeholder="Value"
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove header"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => remove(index)}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {hasInvalidName && (
            <FieldError>A header name cannot contain spaces or a colon.</FieldError>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit border-dashed"
              onClick={() => onChange([...rows, emptyHeaderRow()])}
            >
              <PlusIcon />
              Add header
            </Button>
            {props.onTest && rows.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.onTest}
                loading={props.testing}
              >
                Test connection
              </Button>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Stored with the integration and sent verbatim. Use these for endpoint-level access
            tokens, such as a Cloudflare Access service token. A per-account credential belongs in
            an auth method instead.
          </p>
        </CardStackEntryField>
      </CardStackContent>
    </CardStack>
  );
}
