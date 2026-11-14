import { Avatar, AvatarFallback, AvatarImage } from "@executor-js/ui/components/avatar";

/** Up to two initials of a name or an email, such as "RS" for "Rhys Sullivan". */
const initials = (name: string) =>
  name
    .split(/[\s@._-]+/u)
    .filter((part) => part !== "")
    .map((part) => part[0]?.toUpperCase())
    .join("")
    .slice(0, 2);

/** A person's picture, or their initials while it loads or when they have none. */
export function MemberAvatar({
  name,
  image,
  size = "sm",
  className,
}: {
  readonly name: string;
  readonly image: string | null;
  readonly size?: "sm" | "default" | "lg";
  readonly className?: string;
}) {
  return (
    <Avatar size={size} className={className} aria-hidden>
      {image !== null && <AvatarImage src={image} alt="" referrerPolicy="no-referrer" />}
      <AvatarFallback className="font-medium text-[10px]">{initials(name) || "?"}</AvatarFallback>
    </Avatar>
  );
}
