/** The Artifacts namespace a stage's API Worker keeps app sources in. */
export const sourceNamespace = (stage: string) => `executor-${stage}-apps`;
