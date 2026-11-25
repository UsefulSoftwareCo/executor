declare module "virtual:cloud-release-notes" {
  const notes: import("@executor-js/utils/release-notes").CloudReleaseNotes | null;
  export default notes;
}
