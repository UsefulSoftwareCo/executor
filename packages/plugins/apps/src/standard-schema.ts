export type StandardSchemaIssue = {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
};

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: Input,
    ) =>
      | { readonly value: Output }
      | { readonly issues: readonly StandardSchemaIssue[] }
      | Promise<{ readonly value: Output } | { readonly issues: readonly StandardSchemaIssue[] }>;
  };
}

export namespace StandardSchemaV1 {
  export type InferOutput<T> = T extends StandardSchemaV1<unknown, infer Output> ? Output : never;
}
