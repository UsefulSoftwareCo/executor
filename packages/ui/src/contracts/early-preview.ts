/** Copy shared by the marketing and cloud dashboard beta notices. */
export const earlyPreview = {
  title: "An early look at Executor v2",
  paragraphs: [
    "Executor is in beta. You may run into bugs or changes as we improve it.",
    "If you find a bug or have an idea, ask your agent to submit feedback through the Executor app.",
    "Thanks for trying Executor early and helping shape what comes next.",
  ],
} as const;

/** Browser storage key that keeps the beta notice dismissed across product pages. */
export const betaNoticeDismissalKey = "executor-beta-notice-dismissed";
