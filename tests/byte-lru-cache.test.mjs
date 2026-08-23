import test from "node:test";
import assert from "node:assert/strict";
import { ByteLruCache } from "../src/byte-lru-cache.js";

function cache(maxEntries = 3, maxBytes = 10) {
  return new ByteLruCache({
    maxEntries,
    maxBytes,
    sizeOf: (value) => value.length,
  });
}

test("evicts least-recently-used values to satisfy the byte budget", () => {
  const subject = cache();
  subject.set("a", "1234");
  subject.set("b", "5678");
  subject.get("a");
  subject.set("c", "wxyz");

  assert.equal(subject.has("a"), true);
  assert.equal(subject.has("b"), false);
  assert.equal(subject.has("c"), true);
  assert.equal(subject.totalBytes, 8);
});

test("also enforces the entry limit", () => {
  const subject = cache(2, 100);
  subject.set("a", "1");
  subject.set("b", "2");
  subject.set("c", "3");

  assert.deepEqual([...subject.items.keys()], ["b", "c"]);
});

test("does not retain one value larger than the whole cache", () => {
  const subject = cache();
  assert.equal(subject.set("huge", "12345678901"), false);
  assert.equal(subject.size, 0);
  assert.equal(subject.totalBytes, 0);
});

test("replacement updates accounting without evicting the replacement", () => {
  const subject = cache();
  subject.set("a", "1234");
  subject.set("a", "12");

  assert.equal(subject.get("a"), "12");
  assert.equal(subject.totalBytes, 2);
});
