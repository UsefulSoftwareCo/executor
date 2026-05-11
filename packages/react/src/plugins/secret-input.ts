export const secretValueInputType = (input: {
  readonly revealable: boolean;
  readonly revealed: boolean;
}): "password" | "text" => (input.revealable && input.revealed ? "text" : "password");
