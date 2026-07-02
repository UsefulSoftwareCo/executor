import type { Kysely } from "kysely";
import type { AnySchema } from "../schema";
import type { SQLProvider } from "./providers";

export interface LibraryConfig<Schemas extends AnySchema[] = AnySchema[]> {
  namespace: string;

  /**
   * different versions of schemas (sorted in ascending order)
   */
  schemas: Schemas;

  /**
   * The initial version, it refers to the version of database **before** being initialized.
   *
   * You should not use this version number in your schemas.
   *
   * @defaultValue '0.0.0'
   */
  initialVersion?: string;
}

export interface KyselyConfig {
  db: Kysely<any>;
  provider: SQLProvider;

  /**
   * Define how foreign keys are handled.
   *
   * - `foreign-keys`: rely on database's actual foreign keys.
   * - `fumadb`: rely on FumaDB's simple foreign key engine.
   *
   * When not specified, use `foreign-keys` except for MSSQL.
   */
  relationMode?: RelationMode;
}

export type RelationMode = "foreign-keys" | "@executor-js/fumadb";
