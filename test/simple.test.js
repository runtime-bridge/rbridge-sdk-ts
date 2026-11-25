import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Rbridge, RbridgeError } from "../src/index.js";
import { startDaemon } from "./helpers.js";

let d;
before(async () => {
  d = await startDaemon("echo");
});
after(async () => {
  await d.stop();
});

const make = (opts = {}) => new Rbridge({ workspace: d.workspace, env: d.env, ...opts });

test("run resolves to text and usage", async () => {
  const rb = make();
  const r = await rb.run("hello");
  assert.equal(r.text, "echo: hello");
  assert.equal(String(r), "echo: hello");
  assert.equal(r.runtime, "fake");
  assert.match(r.sessionId, /^ses_/);
  await rb.close();
});

test("streaming is one option", async () => {
  const rb = make();
  const s = await rb.run("streamed", { stream: true });
  let out = "";
  for await (const chunk of s) out += chunk;
  assert.equal(out, "echo: streamed");
  assert.equal(s.response.text, "echo: streamed");
  assert.ok(s.events.some((e) => e.type === "message.delta"));
  assert.equal(await (await rb.run("again", { stream: true })).text(), "echo: again");
  await rb.close();
});

test("a chat keeps one session", async () => {
  const rb = make();
  const chat = rb.chat();
  const [one, two] = [await chat.send("one"), await chat.send("two")];
  assert.deepEqual([one.text, two.text], ["echo: one", "echo: two"]);
  assert.equal(one.sessionId, two.sessionId);
  let streamed = "";
  for await (const c of await chat.send("three", { stream: true })) streamed += c;
  assert.equal(streamed, "echo: three");
  await chat.close();
  await rb.close();
});

test("runMany keeps order and can collect errors", async () => {
  const rb = make();
  const out = await rb.runMany([...Array(6).keys()].map((i) => `p${i}`));
  assert.deepEqual(out.map((r) => r.text), [...Array(6).keys()].map((i) => `echo: p${i}`));
  const mixed = await rb.runMany(["ok", { prompt: "x", runtime: "nope" }], { returnExceptions: true });
  assert.equal(mixed[0].text, "echo: ok");
  assert.ok(mixed[1] instanceof RbridgeError);
  await assert.rejects(rb.runMany(["ok", { prompt: "x", runtime: "nope" }]), (e) => e.code === "provider_not_found");
  await rb.close();
});

test("options are checked and overridable", async () => {
  const rb = make({ runtime: "nope" });
  await assert.rejects(rb.run("x"), (e) => e.code === "provider_not_found");
  assert.equal((await rb.run("x", { runtime: "fake" })).text, "echo: x");
  await assert.rejects(rb.run("x", { runtim: "fake" }), TypeError);
  assert.ok((await rb.runtimes()).some((r) => r.id === "fake" && r.available));
  await rb.close();
});

test("a skill folder is added and used, and the budget stops new runs", async () => {
  const dir = path.join(d.home, "src", "calm");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: calm\ndescription: Keep a calm tone.\n---\nBe calm.\n");
  const rb = make();
  assert.equal((await rb.run("x", { skills: [dir] })).raw.skills[0].skill_id, "calm");
  assert.deepEqual(await rb.addSkills(path.dirname(dir)), ["calm"]);
  await rb.close();
  const broke = make({ maxCostUsd: 0 });
  await assert.rejects(broke.run("x"), (e) => e.code === "budget_exceeded");
});
