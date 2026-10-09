/**
 * The retired homepage hero experiment. The stack no longer declares it, and its state row was
 * retained, so the next deploy orphans the row and leaves the experiment and its results in
 * PostHog. Alchemy needs this provider registered to plan that orphaning; it never creates,
 * changes or deletes anything. Remove it once every stage has deployed without the resource.
 */
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { Effect } from "effect";

interface Props {
  readonly projectId: number;
}
interface Attributes extends Props {
  readonly id: number;
}
/** The retired experiment's resource type, as recorded in existing state. */
export type PostHogHeroExperiment = Resource<"Executor.PostHogHeroExperiment", Props, Attributes>;
/** Not declared by any stack; exists only so Alchemy can resolve the retained row's type. */
export const PostHogHeroExperiment = Resource<PostHogHeroExperiment>(
  "Executor.PostHogHeroExperiment",
);
/** Never touches PostHog: the experiment and its data stay there. */
export const retiredExperimentProvider = () =>
  Provider.succeed(PostHogHeroExperiment, {
    reconcile: () => Effect.die("The hero experiment is retired; do not declare it"),
    delete: () => Effect.void,
  });
