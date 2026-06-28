export default function WorkOSVaultSettings() {
  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden transition-all hover:border-border">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/40">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-foreground leading-none">WorkOS Vault</h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground leading-none">
              Active
            </span>
          </div>
        </div>
      </div>
      <div className="px-5 py-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Cloud secrets are stored directly in WorkOS Vault for this workspace. Postgres is not used
          for secret persistence.
        </p>
      </div>
    </div>
  );
}
