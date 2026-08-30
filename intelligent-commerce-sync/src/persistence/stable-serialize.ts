/**
 * Custom serialization error thrown when encountering invalid data during deterministic serialization.
 */
export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerializationError";
  }
}

function isPlainObjectOrNullProto(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype;
}

/**
 * Deterministically serializes a JavaScript value into a stable JSON string.
 *
 * Guarantees:
 * 1. Object keys are recursively sorted in alphabetical order.
 * 2. Array item order is strictly preserved.
 * 3. Array holes (sparse arrays) and undefined array items serialize to "null".
 * 4. Date objects are serialized to ISO 8601 strings.
 * 5. Undefined object properties are omitted (matching JSON.stringify behavior).
 * 6. Non-finite numbers (NaN, Infinity, -Infinity) throw SerializationError.
 * 7. Unsupported types (functions, symbols, bigints) throw SerializationError.
 * 8. Non-plain objects (Map, Set, RegExp, class instances) throw SerializationError.
 * 9. Objects with Symbol keys throw SerializationError.
 * 10. Circular references are detected and throw SerializationError.
 * 11. Zero external dependencies, strictly type-safe.
 */
export function stableSerialize(value: unknown): string {
  const ancestorSet = new Set<object>();

  function stringifyNode(node: unknown): string {
    if (node === null) {
      return "null";
    }

    const valType = typeof node;

    if (valType === "undefined") {
      return "null";
    }

    if (valType === "boolean") {
      return node ? "true" : "false";
    }

    if (valType === "number") {
      if (!Number.isFinite(node)) {
        throw new SerializationError(`Non-finite number encountered: ${String(node)}`);
      }
      return JSON.stringify(node);
    }

    if (valType === "string") {
      return JSON.stringify(node);
    }

    if (valType === "bigint" || valType === "symbol" || valType === "function") {
      throw new SerializationError(`Unsupported value type: ${valType}`);
    }

    if (valType === "object") {
      const obj = node as object;

      if (ancestorSet.has(obj)) {
        throw new SerializationError("Circular reference detected");
      }

      if (node instanceof Date) {
        if (isNaN(node.getTime())) {
          throw new SerializationError("Invalid Date encountered");
        }
        return JSON.stringify(node.toISOString());
      }

      ancestorSet.add(obj);
      try {
        if (Array.isArray(node)) {
          const serializedItems: string[] = [];
          for (let i = 0; i < node.length; i++) {
            const item = node[i];
            if (!(i in node) || typeof item === "undefined") {
              serializedItems.push("null");
            } else {
              serializedItems.push(stringifyNode(item));
            }
          }
          return `[${serializedItems.join(",")}]`;
        }

        // Must be a plain object with Object.prototype or null prototype
        if (!isPlainObjectOrNullProto(obj)) {
          const tag = Object.prototype.toString.call(obj);
          throw new SerializationError(`Unsupported object instance: ${tag}`);
        }

        // Reject symbol keys on objects
        if (Object.getOwnPropertySymbols(obj).length > 0) {
          throw new SerializationError("Objects with Symbol keys are not supported");
        }

        // Plain record object
        const record = node as Record<string, unknown>;
        const sortedKeys = Object.keys(record).sort();
        const serializedEntries: string[] = [];

        for (const key of sortedKeys) {
          const itemVal = record[key];
          if (typeof itemVal === "undefined") {
            continue;
          }
          serializedEntries.push(`${JSON.stringify(key)}:${stringifyNode(itemVal)}`);
        }

        return `{${serializedEntries.join(",")}}`;
      } finally {
        ancestorSet.delete(obj);
      }
    }

    throw new SerializationError(`Unknown value type: ${valType}`);
  }

  return stringifyNode(value);
}
