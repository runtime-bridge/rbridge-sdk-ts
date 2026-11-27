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

// Captures the text written to stdout while fn runs. The test runner sends
// its own reports through stdout as binary buffers, which pass through.
async function captured(fn) {
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk !== "string") return write.call(this, chunk, ...rest);
    out += chunk;
    return true;
  };
  try {
    return [await fn(), out];
  } finally {
    process.stdout.write = write;
  }
}

test("stream: true prints and resolves to the answer", async () => {
  const rb = make();
  const [r, out] = await captured(() => rb.run("streamed", { stream: true }));
  assert.deepEqual([out, r.text], ["echo: streamed\n", "echo: streamed"]);
  const chunks = [];
  const toFn = make({ stream: (c) => chunks.push(c) });
  assert.equal((await toFn.run("to a function")).text, "echo: to a function");
  assert.equal(chunks.join(""), "echo: to a function");
  await rb.close();
  await toFn.close();
});

test("stream() is the iterator", async () => {
  const rb = make();
  const s = rb.stream("streamed");
  let out = "";
  for await (const chunk of s) out += chunk;
  assert.equal(out, "echo: streamed");
  assert.equal(s.response.text, "echo: streamed");
  assert.ok(s.events.some((e) => e.type === "message.delta"));
  assert.equal(await rb.stream("again").text(), "echo: again");
  await rb.close();
});

test("everything set once", async () => {
  const rb = make({ chat: true, stream: true });
  const [ids, out] = await captured(async () => {
    const first = await rb.run("one");
    const rest = await rb.run(["two", "three"]);
    await rb.reset();
    const fresh = await rb.run("four");
    return [first.sessionId, rest.map((r) => r.sessionId), fresh.sessionId];
  });
  assert.deepEqual(ids[1], [ids[0], ids[0]]);
  assert.notEqual(ids[2], ids[0]);
  assert.equal(out, "echo: one\necho: two\necho: three\necho: four\n");
  await rb.close();
  const plain = make();
  await assert.rejects(plain.run(["a", "b"]), TypeError);
  assert.deepEqual((await plain.run(["a", "b"], { chat: true })).map((r) => r.text), ["echo: a", "echo: b"]);
  await plain.close();
});

test("a chat keeps one session", async () => {
  const rb = make();
  const chat = rb.chat();
  const [one, two] = [await chat.send("one"), await chat.send("two")];
  assert.deepEqual([one.text, two.text], ["echo: one", "echo: two"]);
  assert.equal(one.sessionId, two.sessionId);
  let streamed = "";
  for await (const c of chat.stream("three")) streamed += c;
  assert.equal(streamed, "echo: three");
  assert.deepEqual((await chat.send(["four", "five"])).map((r) => r.text), ["echo: four", "echo: five"]);
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

test("models: a name, auto, and a typo", async () => {
  const rb = make();
  const r = await rb.run("mode?", { model: "large" });
  assert.match(r.text, /model: large/);
  assert.equal(r.model, "large");
  assert.ok((await rb.run("mode?", { model: "auto" })).model);
  await assert.rejects(rb.run("x", { model: "larg" }), (e) => e.code === "invalid_input" && /did you mean large\?/.test(e.message));
  assert.ok("latest" in (await rb.runtimes()).find((x) => x.id === "fake").models);
  await rb.close();
});

test("files go to the runtime, and skills can be listed", async () => {
  const src = path.join(d.home, "in");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "notes.md"), "# Notes\n");
  const rb = new Rbridge({ env: d.env });
  const r = await rb.run("read them", {
    files: [path.join(src, "notes.md"), { name: "data.csv", data: "a,b\n1,2\n" }, new File(["uploaded"], "report.txt")],
  });
  assert.match(r.text, /Files for this task, in your working folder: notes\.md; data\.csv; report\.txt\./);
  const dir = path.join(d.home, "src-tidy", "tidy");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: tidy\ndescription: Keep things tidy.\n---\nTidy.\n");
  await rb.addSkills(dir);
  assert.ok((await rb.skills()).some((s) => s.id === "tidy" && s.description === "Keep things tidy." && s.trust === "reviewed"));
  await rb.close();
});

test("a skill folder is added and used, and the budget stops new runs", async () => {
  const dir = path.join(d.home, "src", "calm");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: calm\ndescription: Keep a calm tone.\n---\nBe calm.\n");
  const rb = make({ runtime: "fake" });
  // The fake runtime cannot load skills, so the run is refused, but only after the folder was added and trusted.
  await assert.rejects(rb.run("x", { skills: [dir] }), (e) => e.code === "capability_unavailable");
  assert.ok((await (await rb.client()).skills()).some((s) => s.id === "calm" && s.trust === "reviewed"));
  assert.deepEqual(await rb.addSkills(path.dirname(dir)), ["calm"]);
  await rb.close();
  const broke = make({ maxCostUsd: 0 });
  await assert.rejects(broke.run("x"), (e) => e.code === "budget_exceeded");
});

test("a program that ends without close exits, and leaves no session open", async () => {
  const { execFile } = await import("node:child_process");
  const entry = new URL("../src/index.js", import.meta.url).href;
  const child = [
    `import { Rbridge } from ${JSON.stringify(entry)};`,
    `const rb = new Rbridge({ workspace: ${JSON.stringify(d.workspace)}, env: ${JSON.stringify(d.env)}, chat: true });`,
    `await rb.run("one");`,
    `await rb.chat().send("two");`,
  ].join("\n");
  const started = Date.now();
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, ...d.env }, timeout: 20000 },
      (err) => (err ? reject(err) : resolve()));
  });
  assert.ok(Date.now() - started < 20000, "the program did not exit by itself");
  const rb = make();
  const client = await rb.client();
  const open = (await client.sessions()).filter((s) => ["ready", "running"].includes(s.state));
  assert.deepEqual(open, []);
  await rb.close();
});
