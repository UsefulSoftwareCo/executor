// Pre-login check of whether the instance still needs first-run setup (its one
// org has zero members). Read by the auth gate to choose the setup vs sign-in
// screen. A plain same-origin fetch — the same boundary the /join + setup
// screens use, which run before the atom registry exists. Two-arg `then` keeps
// it Promise.catch-free; any failure falls back to "no setup needed" (sign-in).
export const fetchNeedsSetup = async (): Promise<boolean> => {
  const response = await fetch("/api/setup-status", { credentials: "same-origin" }).then(
    (r) => r,
    () => null,
  );
  if (!response || !response.ok) return false;
  const data = (await response.json().then(
    (d) => d,
    () => ({}),
  )) as { needsSetup?: boolean };
  return data.needsSetup === true;
};
