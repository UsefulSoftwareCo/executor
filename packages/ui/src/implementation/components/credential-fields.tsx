import type { AccountFormFields } from "../../contracts/credentials.ts";
import { Input } from "@executor-js/ui/components/input";
import { Button } from "./button.tsx";
import { useId, useRef, type ClipboardEvent, type DragEvent } from "react";
import { flushSync } from "react-dom";
import { SetupHelp } from "../dashboard/markdown.tsx";
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

export const fieldLabel = (name: string, field: { readonly title?: string | undefined }) =>
  field.title ?? name.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());

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

const multiline = (text: string) => /[^\r\n][\r\n]+[^\r\n]/.test(text);

const lineCount = (text: string) => text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;

export function CredentialInput({
  value,
  onValueChange,
  required,
  disabled,
  describedBy,
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly required?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly describedBy?: string | undefined;
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
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && /^[yz]$/i.test(event.key)) event.preventDefault();
        }}
      >
        <output
          ref={summary}
          tabIndex={-1}
          aria-describedby={describedBy}
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
      aria-describedby={describedBy}
    />
  );
}

export function CredentialFields({
  fields,
  values,
  onChange,
  pending,
  hosts,
}: {
  readonly fields: AccountFormFields;
  readonly hosts?: readonly string[] | undefined;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Readonly<Record<string, string>>) => void;
  readonly pending: boolean;
}) {
  const help = useId();
  return (
    <>
      {Object.entries(fields.properties).map(([name, field], index) => {
        const described = field.description ? `${help}-${index}` : undefined;
        return (
          <div className="flex flex-col gap-1.5" key={name}>
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
              <span className="flex w-full items-center gap-1.5">
                <span className="min-w-0 wrap-anywhere">{fieldLabel(name, field)}</span>
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
                    <SelectTrigger aria-describedby={described}>
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
                    describedBy={described}
                  />
                ) : (
                  <Input
                    type={field.type === "string" ? "text" : "number"}
                    autoComplete="off"
                    value={values[name] ?? ""}
                    onChange={(event) => onChange({ ...values, [name]: event.target.value })}
                    required={fields.required?.includes(name) === true}
                    step={field.type === "number" ? "any" : undefined}
                    disabled={pending}
                    aria-describedby={described}
                  />
                )}
              </div>
            </label>
            {field.description && described && (
              <SetupHelp id={described}>{field.description}</SetupHelp>
            )}
          </div>
        );
      })}
    </>
  );
}
