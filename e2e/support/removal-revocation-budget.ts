/**
 * Organization removal's revocation budget on the local Cloud that `e2e:cloud
 * --removal-revocation-budget` starts, in milliseconds; deployed, and on every other local Cloud,
 * it is 5 minutes. It must stay under the 10 seconds one revocation in a purge may take, so the
 * budget, not each revocation's own deadline, is what ends a revocation that never answers.
 */
export const removalRevocationBudgetMs = 5_000;
