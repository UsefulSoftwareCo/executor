/** Cloud's notes for this build, or null for a build given none (`release-notes.ts` beside the Vite config). */
declare module "virtual:cloud-release-notes" {
  const notes: import("@executor-js/utils/release-notes").CloudReleaseNotes | null;
  export default notes;
}
