import type { AccountFormFields } from "../../contracts/credentials.ts";
import { Input } from "@executor-js/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";

/** Empty inputs for new credentials; saved values never enter the form. */
export function CredentialFields({
  fields,
  values,
  onChange,
  pending,
}: {
  readonly fields: AccountFormFields;
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
          {field.title ?? name.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
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
            ) : (
              <Input
                type={field.type === "string" ? "password" : "number"}
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
