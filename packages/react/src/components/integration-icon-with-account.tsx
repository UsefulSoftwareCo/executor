import { IntegrationFavicon } from "./integration-favicon";

export function IntegrationIconWithAccount(props: {
  readonly icon?: string | null;
  readonly sourceId: string;
  readonly url?: string;
  readonly size?: "sm" | "md";
}) {
  const iconSize = props.size === "sm" ? 16 : 32;
  return (
    <span className={props.size === "sm" ? "relative size-4 shrink-0" : "relative size-8 shrink-0"}>
      <IntegrationFavicon
        icon={props.icon}
        sourceId={props.sourceId}
        url={props.url}
        size={iconSize}
      />
    </span>
  );
}
