import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalStore, isRiskyTool, riskyArgKeys } from "../src/approvals.js";

test("grants are scoped to tool, server, or the whole session", () => {
  const store = new ApprovalStore();
  assert.equal(store.isGranted("demo", "echo"), false);

  store.grantTool("demo", "echo");
  assert.equal(store.isGranted("demo", "echo"), true);
  assert.equal(store.isGranted("demo", "list_dir"), false);
  assert.equal(store.isGranted("other", "echo"), false);

  store.grantServer("demo");
  assert.equal(store.isGranted("demo", "anything"), true);
  assert.equal(store.isGranted("other", "anything"), false);

  store.grantAll();
  assert.equal(store.isGranted("other", "anything"), true);
  assert.equal(store.size, 3);
});

test("revoking accepts tool, server:<name>, and all scopes", () => {
  const store = new ApprovalStore();
  store.grantTool("demo", "echo");
  store.grantServer("demo");
  store.grantAll();

  assert.equal(store.revoke("demo/echo"), 1);
  assert.equal(store.revoke("server:demo"), 1);
  assert.equal(store.isGranted("demo", "echo"), true, "allow-all still applies");
  assert.equal(store.revoke("all"), 1);
  assert.equal(store.isGranted("demo", "echo"), false);
  assert.equal(store.revoke("never-existed"), 0);
});

test("risky tool names and argument keys are flagged for the approval screen", () => {
  assert.equal(isRiskyTool("write_file"), true);
  assert.equal(isRiskyTool("delete_rows"), true);
  assert.equal(isRiskyTool("search"), false);
  assert.deepEqual(riskyArgKeys({ path: "a", limit: 1, command: "rm" }), ["path", "command"]);
});
