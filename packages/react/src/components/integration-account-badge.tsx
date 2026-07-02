export function IntegrationAccountBadge(props: {
  readonly connection: {
    readonly id: string;
    readonly scopeId: string;
    readonly identityLabel: string | null;
  };
  readonly size?: "sm" | "md";
}) {
  const label = props.connection.identityLabel ?? "Connected";
  const sizeClass = props.size === "sm" ? "size-3 text-[7px]" : "size-4 text-[9px]";
  const badgeClass = `absolute -bottom-1 -right-1 z-10 flex ${sizeClass} items-center justify-center rounded-full border-2 border-card bg-background font-medium leading-none text-muted-foreground shadow-sm`;

  return (
    <span title={label} className={badgeClass}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
