/** Cloud's notes for this build, or null for a build given none (`release-notes.ts` beside the Vite config). */
declare module "virtual:cloud-release-notes" {
  const notes: {
    readonly notes: ReadonlyArray<{ readonly date: string; readonly text: string }>;
  } | null;
  export default notes;
}
