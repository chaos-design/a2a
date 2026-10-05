import assert from "node:assert/strict";
import test from "node:test";
import {
  A2AError,
  CodecRegistry,
  ErrorCode,
  binaryCodec,
  createDefaultCodecRegistry,
  jsonCodec,
  type JsonValue,
} from "../src/index.js";

test("the default registry exposes JSON and binary codecs", () => {
  const registry = createDefaultCodecRegistry();
  assert.equal(registry.supports("application/json"), true);
  assert.equal(registry.supports("application/octet-stream"), true);
  assert.equal(registry.supports("application/xml"), false);
});

test("content types are matched case-insensitively and ignore parameters", () => {
  const registry = new CodecRegistry();
  registry.register(jsonCodec);

  assert.equal(registry.supports("APPLICATION/JSON"), true);
  assert.equal(registry.supports("application/json; charset=utf-8"), true);
  assert.equal(registry.supports("  application/json  "), true);
  // A differently-parameterised type must not be treated as equivalent.
  assert.equal(registry.supports("application/xml; q=json"), false);
});

test("registering the same normalized content type twice conflicts", () => {
  const registry = new CodecRegistry();
  registry.register(jsonCodec);

  assert.throws(
    () => registry.register({ ...jsonCodec }),
    (error: unknown) =>
      error instanceof A2AError &&
      error.code === ErrorCode.Conflict &&
      error.status === 409,
  );
  // Case and parameters must not smuggle a duplicate registration past the guard.
  assert.throws(
    () => registry.register({ ...jsonCodec, contentType: "APPLICATION/JSON" }),
    (error: unknown) => error instanceof A2AError,
  );
});

test("unregistering releases the slot for re-registration", () => {
  const registry = new CodecRegistry();
  const unregister = registry.register(jsonCodec);
  unregister();

  assert.equal(registry.supports("application/json"), false);
  assert.doesNotThrow(() => registry.register(jsonCodec));
});

test("encoding through an unregistered content type reports 415", () => {
  const registry = new CodecRegistry();
  assert.throws(
    () => registry.encode("application/xml", {}),
    (error: unknown) =>
      error instanceof A2AError &&
      error.code === ErrorCode.InvalidMessage &&
      error.status === 415,
  );
  assert.throws(
    () => registry.decode("application/xml", {}),
    (error: unknown) => error instanceof A2AError && error.status === 415,
  );
});

test("the JSON codec round-trips and deep-copies its input", () => {
  const registry = createDefaultCodecRegistry();
  const source = { nested: { list: [1, "two", true, null] } };
  const encoded = registry.encode<JsonValue>("application/json", source);

  // Encoding must snapshot the value, so later mutation cannot change it.
  source.nested.list.push("injected");
  const decoded = registry.decode<typeof source>("application/json", encoded);
  assert.deepEqual(decoded, {
    nested: { list: [1, "two", true, null] },
  });

  // Decoding must also hand back a copy, not a shared reference.
  decoded.nested.list.push("mutated");
  assert.deepEqual(registry.decode("application/json", encoded), {
    nested: { list: [1, "two", true, null] },
  });
});

test("the JSON codec refuses values that are not JSON", () => {
  assert.throws(
    () => jsonCodec.encode({ when: new Date(0) } as unknown as JsonValue),
    (error: unknown) =>
      error instanceof A2AError && error.code === ErrorCode.InvalidMessage,
  );
  assert.throws(
    () => jsonCodec.encode({ missing: undefined } as unknown as JsonValue),
    (error: unknown) => error instanceof A2AError,
  );
  assert.throws(
    () => jsonCodec.encode(Number.NaN as unknown as JsonValue),
    (error: unknown) => error instanceof A2AError,
  );
});

test("the binary codec round-trips arbitrary bytes", () => {
  const registry = createDefaultCodecRegistry();
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const encoded = registry.encode("application/octet-stream", bytes);

  assert.deepEqual(encoded, {
    encoding: "base64url",
    data: "AAF_gP8",
  });
  // The codec returns a Buffer, which is a Uint8Array subclass, so compare the
  // bytes rather than the prototype.
  const decoded = registry.decode<Uint8Array>(
    "application/octet-stream",
    encoded,
  );
  assert.deepEqual([...decoded], [...bytes]);
});

test("the binary codec rejects payloads that are not base64url framed", () => {
  for (const malformed of [
    { encoding: "base64", data: "AAF_gP8" },
    { encoding: "base64url" },
    { data: "AAF_gP8" },
    null,
    "AAF_gP8",
  ]) {
    assert.throws(
      () => binaryCodec.decode(malformed as JsonValue),
      (error: unknown) =>
        error instanceof A2AError &&
        error.code === ErrorCode.InvalidMessage,
      `expected rejection for ${JSON.stringify(malformed)}`,
    );
  }
});

test("a custom codec participates in normalization like the built-ins", () => {
  const registry = new CodecRegistry();
  const unregister = registry.register({
    contentType: "application/x-upper",
    encode: (value: string) => value.toUpperCase(),
    decode: (payload: JsonValue) => String(payload).toLowerCase(),
  });

  assert.equal(registry.encode("APPLICATION/X-UPPER", "shout"), "SHOUT");
  assert.equal(
    registry.decode("application/x-upper; charset=utf-8", "SHOUT"),
    "shout",
  );

  unregister();
  assert.equal(registry.supports("application/x-upper"), false);
});
