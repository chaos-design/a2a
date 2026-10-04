import { A2AError, ErrorCode } from "./errors.js";
import type { JsonValue } from "./types.js";

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new A2AError(
          ErrorCode.InvalidMessage,
          `Non-finite number at ${path}`,
          { status: 400 },
        );
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, index) => serialize(item, `${path}[${index}]`))
          .join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new A2AError(
          ErrorCode.InvalidMessage,
          `Unsupported object at ${path}`,
          { status: 400 },
        );
      }

      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          const item = record[key];
          if (item === undefined) {
            throw new A2AError(
              ErrorCode.InvalidMessage,
              `Undefined value at ${path}.${key}`,
              { status: 400 },
            );
          }
          return `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new A2AError(
        ErrorCode.InvalidMessage,
        `Unsupported JSON value at ${path}`,
        { status: 400 },
      );
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}
