// Smoke test for the structured logger (WP3). Asserts log.info/warn/error
// don't throw and emit single-line, parseable JSON to the right stream.
//
// Run:  node --test apps/engine/test/logger.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { log } from "../src/logger.ts";

function captureStream(
  stream: NodeJS.WriteStream,
  fn: () => void,
): string[] {
  const original = stream.write.bind(stream);
  const chunks: string[] = [];
  stream.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write;
  try {
    fn();
  } finally {
    stream.write = original;
  }
  return chunks;
}

test("log.info emits parseable JSON to stdout and does not throw", () => {
  const chunks = captureStream(process.stdout, () => {
    assert.doesNotThrow(() => log.info("hello", { foo: "bar" }));
  });
  assert.equal(chunks.length, 1);
  const parsed = JSON.parse(chunks[0].trim());
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.foo, "bar");
  assert.ok(typeof parsed.ts === "string");
});

test("log.warn emits parseable JSON to stderr and does not throw", () => {
  const chunks = captureStream(process.stderr, () => {
    assert.doesNotThrow(() => log.warn("careful"));
  });
  assert.equal(chunks.length, 1);
  const parsed = JSON.parse(chunks[0].trim());
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.msg, "careful");
});

test("log.error emits parseable JSON to stderr and does not throw", () => {
  const chunks = captureStream(process.stderr, () => {
    assert.doesNotThrow(() => log.error("boom", { code: 500 }));
  });
  assert.equal(chunks.length, 1);
  const parsed = JSON.parse(chunks[0].trim());
  assert.equal(parsed.level, "error");
  assert.equal(parsed.msg, "boom");
  assert.equal(parsed.code, 500);
});
