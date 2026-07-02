import {
  Binary,
  type ClientSession,
  type Collection,
  type Document,
  type MongoClient,
  ObjectId,
} from "mongodb";
import type {
  ColumnOperation,
  CustomOperation,
  MigrationOperation,
} from "../../../migration-engine/shared";
import {
  type AnyColumn,
  type AnyTable,
  IdColumn,
  type TypeMap,
} from "../../../schema/create";
import {
  bigintToUint8Array,
  booleanToUint8Array,
  numberToUint8Array,
  stringToUint8Array,
  uint8ArrayToBigInt,
  uint8ArrayToBoolean,
  uint8ArrayToNumber,
  uint8ArrayToString,
} from "../../../utils/binary";

interface MongoDBConfig {
  client: MongoClient;
  session?: ClientSession;
}

const errors = {
  IdColumnUpdate:
    "ID columns must not be updated, not every database supports updating primary keys and often requires workarounds.",
};

async function createUniqueIndex(
  collection: Collection<Document>,
  name: string,
  columns: string[]
) {
  const idx: Record<string, 1> = {};
  for (const col of columns) {
    idx[col] = 1;
  }

  await collection.createIndex(idx, {
    name,
    unique: true,
    sparse: true,
  });
}

async function executeColumn(
  collection: Collection<Document>,
  operation: ColumnOperation,
  config: MongoDBConfig
) {
  const { session } = config;

  switch (operation.type) {
    case "rename-column":
      await collection.updateMany(
        {},
        { $rename: { [operation.from]: operation.to } },
        { session }
      );
      return;

    case "drop-column": {
      if (operation.name === "_id")
        throw new Error("You cannot drop `_id` column");
      const indexes = await collection.indexes();

      // drop unique index on it
      for (const index of indexes) {
        if (!index.name || !index.unique || index.key[operation.name] !== 1)
          continue;

        await collection.dropIndex(index.name);
        break;
      }

      await collection.updateMany(
        {},
        { $unset: { [operation.name]: "" } },
        { session }
      );
      return;
    }
    case "create-column": {
      const col = operation.value;
      const defaultValue = col.generateDefaultValue() ?? null;

      if (defaultValue) {
        await collection.updateMany(
          { [col.names.mongodb]: { $exists: false } },
          { $set: { [col.names.mongodb]: defaultValue } },
          { session }
        );
      }
      return;
    }

    // do not handle nullable & default update as they're handled at application level
    case "update-column": {
      const col = operation.value;

      if (col instanceof IdColumn) {
        throw new Error(errors.IdColumnUpdate);
      }

      if (operation.updateDataType) {
        const field = operation.name;
        const bulk = collection.initializeUnorderedBulkOp();

        for await (const doc of collection.find()) {
          bulk.find({ _id: doc._id }).updateOne({
            $set: { [field]: migrateDataType(doc[field], col.type) },
          });
        }

        if (bulk.batches.length > 0) await bulk.execute();
      }
    }
  }
}

export async function execute(
  operation: MigrationOperation,
  config: MongoDBConfig,
  handleCustomNode: (op: CustomOperation) => Promise<void>
): Promise<boolean> {
  const { client, session } = config;
  const db = client.db();

  async function createCollection(table: AnyTable) {
    const collection = await db.createCollection(table.names.mongodb);

    // init unique index, columns are created on insert
    for (const col of Object.values(table.columns)) {
      if (!col.isUnique) continue;

      await createUniqueIndex(collection, col.getUniqueConstraintName(), [
        col.names.sql,
      ]);
    }
  }

  switch (operation.type) {
    case "create-table":
      await createCollection(operation.value);
      return true;

    case "rename-table":
      await db.collection(operation.from).rename(operation.to, { session });
      return true;

    case "update-table": {
      const collection = db.collection(operation.name);

      for (const op of operation.value) {
        await executeColumn(collection, op, config);
      }

      return true;
    }
    case "add-unique-constraint": {
      const collection = db.collection(operation.table);

      await createUniqueIndex(collection, operation.name, operation.columns);
      return true;
    }
    case "drop-table":
      await db.collection(operation.name).drop({ session });
      return true;

    case "custom":
      await handleCustomNode(operation);
      return true;

    case "drop-unique-constraint": {
      const collection = db.collection(operation.table);

      await collection.dropIndex(operation.name);
      return true;
    }
    case "add-foreign-key":
    case "drop-foreign-key":
      // MongoDB doesn't have foreign key constraints
      // This would be handled at the application level
      return false;
  }
}

function migrateDataType(originalValue: unknown, toType: keyof TypeMap) {
  // ignore string constraint
  if (toType.startsWith("varchar(")) toType = "string";
  if (toType === "uuid") toType = "string";

  // just for safe, generally you can't migrate the data type of id column
  if (originalValue instanceof ObjectId)
    originalValue = originalValue.toHexString();

  if (originalValue == null) return originalValue;

  if (toType === "bigint") {
    if (originalValue instanceof Binary) {
      return uint8ArrayToBigInt(originalValue.buffer);
    }

    if (originalValue instanceof Date) return BigInt(originalValue.getTime());

    switch (typeof originalValue) {
      case "bigint":
        return originalValue;
      case "boolean":
        return originalValue ? 1n : 0n;
      case "number":
      case "string":
        return BigInt(originalValue);
      default:
        throw new Error(`Failed to convert ${originalValue} to ${toType}.`);
    }
  }

  if (toType === "bool") {
    if (originalValue instanceof Binary) {
      return uint8ArrayToBoolean(originalValue.buffer);
    }

    switch (typeof originalValue) {
      case "boolean":
        return originalValue;
      case "bigint":
        return originalValue !== 0n;
      case "number":
        return originalValue !== 0;
      case "string":
        return originalValue.toLowerCase() === "true";
      default:
        throw new Error(`Failed to convert ${originalValue} to ${toType}.`);
    }
  }

  if (toType === "binary") {
    if (originalValue instanceof Binary) return originalValue;
    if (originalValue instanceof Date) originalValue = originalValue.getTime();

    switch (typeof originalValue) {
      case "bigint":
        return new Binary(bigintToUint8Array(originalValue));
      case "string":
        return new Binary(stringToUint8Array(originalValue));
      case "number":
        return new Binary(numberToUint8Array(originalValue));
      case "boolean":
        return new Binary(booleanToUint8Array(originalValue));
      default:
        throw new Error(`Failed to convert ${originalValue} to ${toType}.`);
    }
  }

  if (toType === "date" || toType === "timestamp") {
    if (originalValue instanceof Binary)
      return new Date(uint8ArrayToNumber(originalValue.buffer));
    if (originalValue instanceof Date) return originalValue;

    switch (typeof originalValue) {
      case "bigint":
        // ignore precision loss, we assume bigint when used as time, won't exceed the safe integer range.
        return new Date(Number(originalValue));
      case "string":
      case "number":
        return new Date(originalValue);
      default:
        throw new Error(`Failed to convert ${originalValue} to ${toType}.`);
    }
  }

  if (toType === "decimal" || toType === "integer") {
    if (originalValue instanceof Binary)
      return uint8ArrayToNumber(originalValue.buffer);
    if (originalValue instanceof Date) return originalValue.getTime();

    switch (typeof originalValue) {
      case "bigint":
      case "string":
      case "number":
        return Number(originalValue);
      case "boolean":
        return originalValue ? 1 : 0;
      default:
        throw new Error(`Failed to convert ${originalValue} to ${toType}.`);
    }
  }

  // MongoDB can just store JSON-compatible values, not conversion needed
  if (toType === "json") return originalValue;

  if (toType === "string") {
    if (originalValue instanceof Binary)
      return uint8ArrayToString(originalValue.buffer);

    switch (typeof originalValue) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
        return String(originalValue);
      default:
        return JSON.stringify(originalValue);
    }
  }
}
