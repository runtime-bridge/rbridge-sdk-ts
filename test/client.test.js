import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connect, connectHTTP, RbridgeError, text } from "../src/index.js";
import { startDaemon } from "./helpers.js";

let d;
before(async () => {
  d = await startDaemon("echo");
});
after(async () => {
  await d.stop();
});

test("run over IPC streams events and returns the result", async () => {
  const c = await connect({ env: d.env, client: "ts-test" });
  const types = [];
  const res = await c.run({ workspace: d.workspace, prompt: "from node" }, { onEvent: (e) => types.push(e.type) });
  assert.equal(res.output, "echo: from node");
  assert.equal(res.stop_reason, "end_turn");
  assert.ok(types.includes("session.started"), types.join(","));
  assert.ok(types.includes("message.delta"));
  const sessions = await c.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].state, "closed");
  c.close();
});

test("multi-turn session and resume", async () => {
  const c = await connect({ env: d.env, client: "ts-multi" });
  const s = await c.open({ workspace: d.workspace });
  assert.equal((await s.prompt("one")).output, "echo: one");
  assert.equal((await s.prompt(text("two"))).output, "echo: two");
  await s.close();
  const again = await c.resume(s.id);
  assert.equal((await again.prompt("three")).output, "echo: three");
  await again.close();
  c.close();
});

test("errors keep their code", async () => {
  const c = await connect({ env: d.env });
  await assert.rejects(c.run({ workspace: "relative", prompt: "x" }), (e) => e instanceof RbridgeError && e.code === "invalid_input");
  await assert.rejects(c.resume("ses_missing"), (e) => e.code === "session_not_found");
  c.close();
});

test("clients see only their own sessions", async () => {
  const a = await connect({ env: d.env, client: "ts-a" });
  const b = await connect({ env: d.env, client: "ts-b" });
  const s = await a.open({ workspace: d.workspace });
  assert.equal((await b.sessions()).length, 0);
  await assert.rejects(b.resume(s.id), (e) => e.code === "session_not_found");
  await s.close();
  a.close();
  b.close();
});

test("HTTP transport with SSE events", async () => {
  const c = await connectHTTP({ env: d.env, client: "ts-http" });
  const status = await c.status();
  assert.ok(status.pid > 0);
  const providers = await c.providers();
  assert.ok(providers.some((p) => p.id === "fake" && p.runtime.health === "available"));
  const types = [];
  const res = await c.run({ workspace: d.workspace, prompt: "over http" }, { onEvent: (e) => types.push(e.type) });
  assert.equal(res.output, "echo: over http");
  assert.ok(types.includes("turn.started"), types.join(","));
});

test("missing daemon gives provider_unavailable", async () => {
  await assert.rejects(connect({ socket: path.join(d.home, "nope.sock") }), (e) => e.code === "provider_unavailable");
});

test("approvals reach the approver", async () => {
  const p = await startDaemon("permission");
  try {
    const c = await connect({ env: p.env });
    const asked = [];
    const res = await c.run(
      { workspace: p.workspace, prompt: "write", profile: "controlled" },
      { approver: (req) => (asked.push(req.title), true) },
    );
    assert.equal(res.output, "allowed");
    assert.deepEqual(asked, ["Write notes.txt"]);
    assert.ok(fs.existsSync(path.join(p.workspace, "notes.txt")));
    fs.rmSync(path.join(p.workspace, "notes.txt"));
    const denied = await c.run({ workspace: p.workspace, prompt: "write", profile: "controlled" });
    assert.equal(denied.output, "denied");
    let count = 0;
    const s = await c.open({ workspace: p.workspace, profile: "controlled" }, { approver: () => (count++, { allow: true, remember: true }) });
    assert.equal((await s.prompt("write")).output, "allowed");
    assert.equal((await s.prompt("write")).output, "allowed");
    await s.close();
    assert.equal(count, 1, "remember must spare the second question");
    c.close();
  } finally {
    await p.stop();
  }
});
