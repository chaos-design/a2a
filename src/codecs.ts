import { cloneJson, isJsonValue } from "./canonical-json.js";
import { A2AError, ErrorCode } from "./errors.js";
import type { JsonValue } from "./types.js";

export interface PayloadCodec<T> {
  readonly contentType: string;
  encode(value: T): JsonValue;
  decode(payload: JsonValue): T;
}

export class CodecRegistry {
  private readonly codecs = new Map<string, PayloadCodec<unknown>>();

  register<T>(codec: PayloadCodec<T>): () => void {
    const key = this.normalize(codec.contentType);
    if (this.codecs.has(key)) {
      throw new A2AError(
        ErrorCode.Conflict,
        `A codec is already registered for ${key}`,
        { status: 409 },
      );
    }
    this.codecs.set(key, codec as PayloadCodec<unknown>);
    return () => {
      this.codecs.delete(key);
    };
  }

  encode<T>(contentType: string, value: T): JsonValue {
    return this.resolve<T>(contentType).encode(value);
  }

  decode<T>(contentType: string, payload: JsonValue): T {
    return this.resolve<T>(contentType).decode(payload);
  }

  supports(contentType: string): boolean {
    return this.codecs.has(this.normalize(contentType));
  }

  private resolve<T>(contentType: string): PayloadCodec<T> {
    const codec = this.codecs.get(this.normalize(contentType));
    if (!codec) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        `No payload codec is registered for ${contentType}`,
        { status: 415 },
      );
    }
    return codec as PayloadCodec<T>;
  }

  private normalize(contentType: string): string {
    return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? contentType;
  }
}

export const jsonCodec: PayloadCodec<JsonValue> = {
  contentType: "application/json",
  encode(value): JsonValue {
    if (!isJsonValue(value)) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        "JSON codec received a non-JSON value",
        { status: 400 },
      );
    }
    return cloneJson(value);
  },
  decode(payload): JsonValue {
    return cloneJson(payload);
  },
};

interface EncodedBytes {
  encoding: "base64url";
  data: string;
}

export const binaryCodec: PayloadCodec<Uint8Array> = {
  contentType: "application/octet-stream",
  encode(value): JsonValue {
    return {
      encoding: "base64url",
      data: Buffer.from(value).toString("base64url"),
    };
  },
  decode(payload): Uint8Array {
    // The payload arrives from the wire, so guard the shape before reading it:
    // dereferencing null would raise a TypeError instead of a protocol error.
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        "Binary payload must use base64url encoding",
        { status: 400 },
      );
    }
    const encoded = payload as Partial<EncodedBytes>;
    if (
      encoded.encoding !== "base64url" ||
      typeof encoded.data !== "string"
    ) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        "Binary payload must use base64url encoding",
        { status: 400 },
      );
    }
    return Buffer.from(encoded.data, "base64url");
  },
};

export function createDefaultCodecRegistry(): CodecRegistry {
  const registry = new CodecRegistry();
  registry.register(jsonCodec);
  registry.register(binaryCodec);
  return registry;
}
