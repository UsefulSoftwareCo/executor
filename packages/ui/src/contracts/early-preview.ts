/** Copy shared by the marketing and cloud dashboard beta notices. */
export const earlyPreview = {
  title: "An early look at Executor v2",
  migration: {
    title: "Where is my v1 data?",
    description:
      "We expect to migrate your v1 data in about a week. This is an early build of Executor v2. Try the new version, share feedback, and help us squash bugs.",
  },
  paragraphs: [
    "For now, Executor v2 is only available on the cloud. Desktop and self-hosted versions are coming.",
    "Expect bugs. If you find one or have an idea, ask your agent to submit feedback through the Executor app.",
    "I’ll do my best to avoid breaking changes, but there may be some before the full launch. This preview is a chance to get hands-on with the product early and help shape it with your feedback.",
  ],
} as const;

/** Browser storage key that keeps the beta notice dismissed across product pages. */
export const betaNoticeDismissalKey = "executor-beta-notice-dismissed";
