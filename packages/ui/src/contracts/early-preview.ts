/** Copy shared by the marketing and cloud dashboard beta notices. */
export const earlyPreview = {
  title: "An early look at Executor v2",
  migration: {
    title: "Where is my v1 data?",
    description:
      "We expect to migrate your v1 data in about a week. This is an early build of Executor v2. Try the new version, share feedback, and help us squash bugs.",
  },
  paragraphs: ["Sit back enjoy v1 and you'll be cleanly migrated over soon"],
} as const;

/** Browser storage key that keeps the beta notice dismissed across product pages. */
export const betaNoticeDismissalKey = "executor-beta-notice-dismissed";
