import type { AccountFormFields } from "../../contracts/credentials.ts";
import { Input } from "@executor-js/ui/components/input";
import { Button } from "./button.tsx";
import { useRef, type ClipboardEvent, type DragEvent } from "react";
import { flushSync } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { SquareLock02Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import { useProductBrand } from "../hooks/product-brand.ts";

/** A field's title, or its name in words: `apiKey` reads "Api Key". */
export const fieldLabel = (name: string, field: { readonly title?: string | undefined }) =>
  field.title ?? name.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());

/**
 * Whether the app gets a secret field's value. A provider with hosts hides unmarked fields behind
 * placeholders; its `raw()` fields, and every field of a provider without hosts, are readable.
 */
function FieldAccess({
  hidden,
  hosts,
}: {
  readonly hidden: boolean;
  readonly hosts?: readonly string[] | undefined;
}) {
  const brand = useProductBrand();
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="img"
            aria-label={hidden ? "Hidden from app" : "Readable by app"}
            data-field-access={hidden ? "hidden" : "readable"}
            className={`ml-auto flex cursor-help items-center ${
              hidden
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-amber-700 dark:text-amber-400"
            }`}
          >
            <HugeiconsIcon icon={hidden ? SquareLock02Icon : ViewIcon} className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          {hidden
            ? `The app and your agent only see a placeholder. ${brand.name} swaps in the real value on requests to ${hosts?.join(", ")}.`
            : "The app reads this value and can send it anywhere."}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Whether `text` spans lines: it has a line break between other characters. */
const multiline = (text: string) => /[^\r\n][\r\n]+[^\r\n]/.test(text);

/** How many lines `text` has. A line break at its end doesn't start another. */
const lineCount = (text: string) => text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;

/**
 * A secret credential's text box. An `<input>` turns pasted line breaks into spaces, which changes
 * a multi-line secret such as a PEM private key, and only a password input hides its text from
 * assistive software. So a paste or drop that spans lines doesn't go into the input: it replaces
 * the whole value, exactly as pasted, and the field shows a summary that holds none of the text.
 * Clear goes back to the empty input. A value without line breaks is the input, as before.
 */
export function CredentialInput({
  value,
  onValueChange,
  required,
  disabled,
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly required?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLOutputElement>(null);
  const take = (
    event: ClipboardEvent<HTMLInputElement> | DragEvent<HTMLInputElement>,
    data: DataTransfer,
  ) => {
    const text = data.getData("text/plain");
    if (!multiline(text)) return;
    event.preventDefault();
    flushSync(() => onValueChange(text));
    summary.current?.focus();
  };
  if (/[\r\n]/.test(value)) {
    const lines = lineCount(value);
    return (
      <div
        className="max-[740px]:min-h-11 flex h-9 w-full items-center gap-2 rounded-md border border-input pr-0.5 pl-3 shadow-xs has-[output:focus-visible]:border-ring has-[output:focus-visible]:ring-[3px] has-[output:focus-visible]:ring-ring/50 dark:bg-input/30"
        // Undo here would reach past this field to the page's previous edit, such as another field.
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && /^[yz]$/i.test(event.key)) event.preventDefault();
        }}
      >
        {/* The first control in the field's label, so clicking the label doesn't press Clear. */}
        <output
          ref={summary}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-sm text-muted-foreground outline-none select-none"
        >
          {`Multi-line value · ${lines} ${lines === 1 ? "line" : "lines"}`}
        </output>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            flushSync(() => onValueChange(""));
            input.current?.focus();
          }}
        >
          Clear
        </Button>
      </div>
    );
  }
  return (
    <Input
      ref={input}
      type="password"
      autoComplete="off"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      onPaste={(event) => take(event, event.clipboardData)}
      onDrop={(event) => take(event, event.dataTransfer)}
      required={required}
      disabled={disabled}
    />
  );
}

/** Empty inputs for new credentials; saved values never enter the form. */
export function CredentialFields({
  fields,
  values,
  onChange,
  pending,
  hosts,
}: {
  readonly fields: AccountFormFields;
  /** The provider's credential hosts. Without them the app reads every secret. */
  readonly hosts?: readonly string[] | undefined;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Readonly<Record<string, string>>) => void;
  readonly pending: boolean;
}) {
  return (
    <>
      {Object.entries(fields.properties).map(([name, field]) => (
        <label
          className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full"
          key={name}
        >
          <span className="flex w-full items-center gap-1.5">
            {fieldLabel(name, field)}
            {field.type === "string" && !fields.plain?.includes(name) && (
              <FieldAccess
                hidden={hosts !== undefined && !fields.raw?.includes(name)}
                hosts={hosts}
              />
            )}
          </span>
          <div data-private>
            {field.type === "boolean" || field.enum ? (
              <Select
                value={values[name] ?? ""}
                onValueChange={(value) => onChange({ ...values, [name]: value })}
                disabled={pending}
                required={fields.required?.includes(name) === true}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a value" />
                </SelectTrigger>
                <SelectContent data-private>
                  {(field.enum ?? [true, false]).map((value) => (
                    <SelectItem value={String(value)} key={String(value)}>
                      {String(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : field.type === "string" && !fields.plain?.includes(name) ? (
              <CredentialInput
                value={values[name] ?? ""}
                onValueChange={(value) => onChange({ ...values, [name]: value })}
                required={fields.required?.includes(name) === true}
                disabled={pending}
              />
            ) : (
              // A plain value is shown, and the summary would hide it, so it keeps main's input.
              <Input
                type={field.type === "string" ? "text" : "number"}
                autoComplete="off"
                value={values[name] ?? ""}
                onChange={(event) => onChange({ ...values, [name]: event.target.value })}
                required={fields.required?.includes(name) === true}
                step={field.type === "number" ? "any" : undefined}
                disabled={pending}
              />
            )}
          </div>
          {field.description && (
            <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
              {field.description}
            </span>
          )}
        </label>
      ))}
    </>
  );
}
