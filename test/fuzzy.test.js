import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyMatch, rankByFuzzy } from "../src/fuzzy.js";

test("fuzzy matching returns the matched indices for highlighting", () => {
  const match = fuzzyMatch("srv", "/servers");
  assert.ok(match);
  assert.deepEqual(match.indices, [1, 3, 4]);
  assert.equal(fuzzyMatch("zzz", "/servers"), null);
  assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, indices: [] });
});

test("word boundaries and consecutive runs score higher", () => {
  const boundary = fuzzyMatch("r", "read_file");
  const middle = fuzzyMatch("a", "read_file");
  assert.ok(boundary.score > middle.score);

  const ranked = rankByFuzzy(
    [
      { label: "disconnect", searchText: "disconnect" },
      { label: "connect", searchText: "connect" },
    ],
    "conn"
  );
  assert.equal(ranked[0].item.label, "connect");
});

test("ranking does not mutate the items", () => {
  const items = [{ label: "servers", searchText: "servers" }];
  const ranked = rankByFuzzy(items, "srv");
  assert.equal(ranked.length, 1);
  assert.deepEqual(items, [{ label: "servers", searchText: "servers" }]);
  assert.equal("__match" in items[0], false);
});

test("smart case only applies when the query has capitals", () => {
  assert.equal(fuzzyMatch("READ", "read"), null);
  assert.ok(fuzzyMatch("read", "READ"));
});
