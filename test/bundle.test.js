import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findBinary, projectDir } from "../src/bundle.js";

test("the project is the folder holding the outermost node_modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-proj-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const deep = path.join(root, "node_modules", "a", "node_modules", "@rbridge", "sdk", "src");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(projectDir(deep), root);
  const pnpm = path.join(root, "node_modules", ".pnpm", "x@1", "node_modules", "@rbridge", "sdk", "src");
  assert.equal(projectDir(pnpm), root);
});

test("a global install, or a checkout outside node_modules, has no project", () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "rb-global-"));
  assert.equal(projectDir(path.join(prefix, "lib", "node_modules", "@rbridge", "sdk", "src")), null);
  assert.equal(projectDir(path.join(prefix, "rbridge-sdk-ts", "src")), null);
});

test("RBRIDGE_BIN wins, and rbridge commands inside node_modules are skipped", () => {
  assert.equal(findBinary({ RBRIDGE_BIN: "/mine/rbridge" }), "/mine/rbridge");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-path-"));
  const shim = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, "rbridge"), "");
  assert.equal(findBinary({ PATH: shim }), null);
});
