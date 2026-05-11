import { lazy } from "react";
import type { SourcePlugin } from "@executor-js/sdk/client";
import { graphqlPresets } from "../sdk/presets";

const importAdd = () => import("./AddGraphqlSource");
const importEdit = () => import("./EditGraphqlSource");
const importSummary = () => import("./GraphqlSourceSummary");

export const graphqlSourcePlugin: SourcePlugin = {
  key: "graphql",
  label: "GraphQL",
  add: lazy(importAdd),
  edit: lazy(importEdit),
  summary: lazy(importSummary),
  presets: graphqlPresets,
  preload: () => {
    void importAdd();
    void importEdit();
    void importSummary();
  },
};
