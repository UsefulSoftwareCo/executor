export type JSONSchema4TypeName =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "any";

export type JSONSchema4Type =
  | string
  | number
  | boolean
  | null
  | JSONSchema4Object
  | JSONSchema4Type[];

export interface JSONSchema4Object {
  [key: string]: any;
}

export interface JSONSchema4 {
  [key: string]: any;
  $id?: string;
  $ref?: string;
  $schema?: string;
  $defs?: Record<string, JSONSchema4>;
  additionalItems?: boolean | JSONSchema4;
  additionalProperties?: boolean | JSONSchema4;
  allOf?: JSONSchema4[];
  anyOf?: JSONSchema4[];
  default?: JSONSchema4Type;
  definitions?: Record<string, JSONSchema4>;
  dependencies?: Record<string, JSONSchema4 | string[]>;
  description?: string;
  enum?: JSONSchema4Type[];
  extends?: string[];
  id?: string;
  items?: JSONSchema4 | JSONSchema4[];
  maxItems?: number;
  minItems?: number;
  not?: JSONSchema4;
  oneOf?: JSONSchema4[];
  patternProperties?: Record<string, JSONSchema4>;
  properties?: Record<string, JSONSchema4>;
  required?: string[] | false;
  title?: string;
  type?: JSONSchema4TypeName | JSONSchema4TypeName[];
}
