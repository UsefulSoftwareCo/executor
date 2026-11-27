import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { cn } from "@executor-js/ui/lib/utils";
import { useId, type ComponentProps, type ReactNode } from "react";

export function OrganizationForm({ className, ...props }: ComponentProps<"form">) {
  return <form className={cn("flex flex-col gap-5", className)} {...props} />;
}

export function OrganizationFormHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex items-center gap-3.5 [&_h1]:text-2xl [&_h1]:font-medium [&_h1]:tracking-[-0.04em] [&_h2]:text-xl [&_h2]:font-medium [&_h2]:tracking-[-0.03em]",
        className,
      )}
      {...props}
    />
  );
}

export function OrganizationFormField({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & { readonly label: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {label}
      </label>
      <Input id={id} className={cn("h-12 px-3.5 text-base", className)} {...props} />
    </div>
  );
}

export function OrganizationFormError({ children }: { readonly children: ReactNode }) {
  return children ? (
    <p className="auth-error text-[13px] text-destructive" role="alert">
      {children}
    </p>
  ) : null;
}

export function OrganizationFormSubmit({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "type">) {
  return (
    <Button
      className={cn("mt-2.5 min-h-12 w-full text-base", className)}
      type="submit"
      {...props}
    />
  );
}
