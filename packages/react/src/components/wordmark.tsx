import { cn } from "../lib/utils";

/**
 * The product wordmark: `executor` set in Geist Mono, with a quiet `beta` tag.
 *
 * Registry-minimal (see design.md): identity comes from restraint, not
 * decoration. The release tag is muted mono metadata sitting next to the
 * wordmark, NOT a filled pill or a brand-hued badge. Shared by the desktop/web
 * shell and the multiplayer shell so the brand reads identically everywhere.
 */
export function Wordmark(props: { readonly className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-1.5", props.className)}>
      <span className="font-mono text-sm font-medium tracking-tight text-foreground">executor</span>
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        beta
      </span>
    </span>
  );
}
