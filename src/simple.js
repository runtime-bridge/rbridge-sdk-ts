// The everyday API: Rbridge.
//
//   import { Rbridge } from "@rbridge/sdk";
//
//   const rb = new Rbridge({ runtime: "claude-code" });
//   console.log((await rb.run("Summarise README.md")).text);
//
//   await rb.run("Explain app.js", { stream: true });     // printed as it is written
//
//   const bot = new Rbridge({ runtime: "claude-code", chat: true, stream: true });
//   await bot.run("What does app.js do?");                // one conversation,
//   await bot.run("Now write tests for it");              // streamed, remembered
//   await bot.run(["Summarise it", "Shorter"]);           // several messages, one call
//
//   const answers = await rb.runMany(["Review a.js", "Review b.js"]);
//
// Connections, sessions, events and approvals are handled here. The
// lower-level Client stays available as await rb.client() for anything this
// does not cover.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connect, RbridgeError } from "./index.js";

const OPTIONS = ["runtime", "model", "workspace", "skills", "profile", "approve", "sandbox", "timeout", "files"];

/** What a runtime answered. */
export class Response {
  constructor(raw) {
    const u = raw.usage ?? {};
    this.text = raw.output ?? "";
    this.runtime = raw.provider ?? "";
    this.sessionId = raw.session_id ?? "";
    this.stopReason = raw.stop_reason ?? "";
    /** The model that ran, as the runtime reported it (what latest or auto became). */
    this.model = raw.model ?? "";
    this.usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, costUsd: u.cost_usd ?? 0 };
    let data = raw.structured ?? null;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        // left as text
      }
    }
    /** The answer parsed as JSON when a schema was given, else null. */
    this.data = data;
    /** With a schema that can parse (such as Zod), the answer it parsed. */
    this.parsed = undefined;
    /** The full result as the daemon sent it. */
    this.raw = raw;
  }

  toString() {
    return this.text;
  }
}

/**
 * The answer as it is written: `for await (const chunk of stream)` yields
 * text. Once it is done, `stream.response` holds the full Response; every
 * event the runtime sent is in `stream.events`.
 */
export class Stream {
  constructor(start) {
    this.response = null;
    this.events = [];
    this.chunks = [];
    this.wake = null;
    this.done = false;
    this.error = null;
    let streamed = "";
    let ended = false;
    const onEvent = (ev) => {
      if (ended) return;
      this.events.push(ev);
      if (ev.type === "message.delta") {
        const chunk = ev.data?.text ?? "";
        streamed += chunk;
        this.#push(chunk);
      }
    };
    this.finished = start(onEvent).then(
      (raw) => {
        this.response = new Response(raw);
        // Deltas can trail the result; whatever has not arrived yet is taken
        // from the result, so the chunks always add up to it.
        ended = true;
        const text = this.response.text;
        if (text.startsWith(streamed) && text.length > streamed.length) this.#push(text.slice(streamed.length));
      },
      (err) => {
        this.error = err;
      },
    ).finally(() => {
      ended = true;
      this.done = true;
      this.wake?.();
    });
  }

  #push(chunk) {
    this.chunks.push(chunk);
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.chunks.length) {
        yield this.chunks.shift();
        continue;
      }
      if (this.done) break;
      await new Promise((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
    if (this.error) throw this.error;
  }

  /** Waits for the whole answer and returns its text. */
  async text() {
    await this.finished;
    if (this.error) throw this.error;
    return this.response.text;
  }
}

// Hands every chunk to the terminal (stream: true) or to the given function,
// then resolves to the whole Response.
async function deliver(stream, to) {
  for await (const chunk of stream) {
    if (typeof to === "function") to(chunk);
    else process.stdout.write(chunk);
  }
  const text = stream.response?.text ?? "";
  if (typeof to !== "function" && text && !text.endsWith("\n")) process.stdout.write("\n");
  return stream.response;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// With a schema that can parse (such as Zod), the answer it parsed.
function parsed(r, schema) {
  if (r && r.data != null && schema && typeof schema.parse === "function") r.parsed = schema.parse(r.data);
  return r;
}

// Paths for the files a run brings. Paths are used as they are; uploads
// ({ name, data }, or a File or Blob from a form) are written to a temporary
// folder, removed once rbridge has copied them.
async function stage(files) {
  const paths = [];
  let tmp = null;
  const spill = (name, bytes) => {
    tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "rbridge-upload-"));
    const dest = path.join(tmp, path.basename(name || "upload"));
    fs.writeFileSync(dest, bytes);
    return dest;
  };
  for (const f of files ?? []) {
    if (typeof f === "string") paths.push(path.resolve(f));
    else if (f && typeof f.arrayBuffer === "function") paths.push(spill(f.name, Buffer.from(await f.arrayBuffer())));
    else if (f && f.name && f.data != null) paths.push(spill(f.name, typeof f.data === "string" ? Buffer.from(f.data) : f.data));
    else throw new TypeError("files takes paths, { name, data } objects, or File and Blob objects");
  }
  return { paths, cleanup: () => tmp && fs.rmSync(tmp, { recursive: true, force: true }) };
}

const isMessages = (p) => Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === "string");

function approver(approve) {
  if (approve == null || approve === false || approve === "deny") return undefined;
  if (approve === true || approve === "allow") return async () => true;
  if (approve === "read") return async (req) => ["read", "search", "think"].includes(req.kind);
  if (typeof approve === "function") return approve;
  throw new TypeError("approve must be true, false, 'allow', 'deny', 'read' or a function");
}

/**
 * One place to run prompts on the agent runtimes installed here. Every option
 * is a default for the calls that follow, and each call can override it:
 * runtime (an id from rb.runtimes(), such as "claude-code"; unset lets
 * rbridge choose), model ("latest" for the runtime's newest flagship, "auto"
 * for its own recommended choice, or a model name), workspace (default: the
 * current folder), skills
 * (ids, or folders of skills your program ships), profile ("observe" for
 * read-only, "standard", "controlled"), approve (false to deny permission
 * requests, true to allow, "read" for reads only, or a function), sandbox
 * ("files" or "full"), timeout (seconds), maxConcurrency for runMany, and
 * maxCostUsd, after which no new run starts.
 *
 * stream: true prints every answer as it is written (or pass a function to
 * receive the chunks); run still resolves to the whole Response. chat: true
 * makes every run continue one conversation; rb.reset() starts a new one.
 */
export class Rbridge {
  constructor({ maxConcurrency = 4, maxCostUsd, queueTimeout, stream = false, chat = false, app = "default", env, client, ...defaults } = {}) {
    this.#check(defaults);
    this.defaults = { skills: [], approve: false, ...defaults };
    this.maxConcurrency = maxConcurrency;
    /** Seconds a run may wait for rbridge to have room; unset waits as long as it takes. */
    this.queueTimeout = queueTimeout;
    this.maxCostUsd = maxCostUsd;
    /** Tokens and cost across every run made through this object. */
    this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.app = app;
    this.env = env;
    this.connection = client ? Promise.resolve(client) : null;
    this.streamTo = stream;
    this.chatting = chat;
    this.conversation = null;
  }

  #check(opts) {
    const unknown = Object.keys(opts).filter((k) => !OPTIONS.includes(k) && k !== "schema" && k !== "stream" && k !== "onEvent");
    if (unknown.length) throw new TypeError(`unknown option ${unknown.join(", ")}`);
  }

  /** The lower-level Client, connected on first use. */
  client() {
    this.connection ??= connect({ client: this.app, env: this.env });
    return this.connection;
  }

  #options(overrides) {
    this.#check(overrides);
    const o = { ...this.defaults };
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) o[k] = v;
    if (this.maxCostUsd != null && this.usage.costUsd >= this.maxCostUsd) {
      throw new RbridgeError("budget_exceeded", `spent $${this.usage.costUsd.toFixed(4)} of the $${this.maxCostUsd} budget`);
    }
    return o;
  }

  async #task(prompt, o) {
    const t = { prompt };
    if (o.workspace || !o.files?.length) t.workspace = path.resolve(o.workspace || process.cwd());
    if (o.runtime) t.provider = o.runtime;
    // A folder (of one skill or several) is added and trusted by rbridge.
    if (o.skills?.length) t.skills = o.skills.map((s) => (isDir(s) ? path.resolve(s) : s));
    if (o.profile) t.profile = o.profile;
    if (o.sandbox) t.sandbox = o.sandbox;
    if (o.schema) t.output_schema = typeof o.schema.toJSONSchema === "function" ? o.schema.toJSONSchema() : o.schema;
    if (o.timeout) t.timeout = Math.round(o.timeout * 1e9);
    // Wait for a free session slot instead of failing when rbridge is busy.
    t.slot_wait = this.queueTimeout == null ? -1 : Math.max(1, Math.round(this.queueTimeout * 1e9));
    return t;
  }

  #count(raw) {
    const r = raw instanceof Response ? raw : new Response(raw);
    this.usage.inputTokens += r.usage.inputTokens;
    this.usage.outputTokens += r.usage.outputTokens;
    this.usage.costUsd = Math.round((this.usage.costUsd + r.usage.costUsd) * 1e6) / 1e6;
    return r;
  }

  // Opens a session, retrying while rbridge says the request may succeed later
  // (rate limits, a daemon restarting). Nothing has run yet, so a retry
  // repeats no work; a prompt is never retried.
  async #open(t, o, onEvent) {
    const giveUp = this.queueTimeout == null ? null : Date.now() + this.queueTimeout * 1000;
    let delay = 200;
    const staged = await stage(o.files);
    if (staged.paths.length) t = { ...t, files: staged.paths };
    try {
      for (;;) {
        try {
          // rbridge copies the files when the session opens.
          return await (await this.client()).open(t, { onEvent, approver: approver(o.approve), model: o.model });
        } catch (e) {
          if (!e.retryable || (giveUp != null && Date.now() + delay > giveUp)) throw e;
        }
        await new Promise((r) => setTimeout(r, delay + Math.random() * delay / 2));
        delay = Math.min(delay * 2, 5000);
      }
    } finally {
      staged.cleanup();
    }
  }

  #stream(prompt, o, onEvent) {
    return new Stream(async (sink) => {
      const t = await this.#task(prompt, o);
      const s = await this.#open(t, o, (ev) => {
        sink?.(ev);
        onEvent?.(ev);
      });
      try {
        const raw = await s.prompt(prompt);
        this.#count(raw);
        return raw;
      } finally {
        await s.close();
      }
    });
  }

  #defaultChat(options) {
    this.conversation ??= new Chat(this, this.#options(options));
    return this.conversation;
  }

  /**
   * Runs a prompt and resolves to its Response. { stream: true } prints the
   * answer as it is written (a function receives the chunks instead); the
   * defaults come from new Rbridge({ stream, chat }). With chat, the prompt
   * continues this object's conversation, and an array of messages is sent
   * in order, resolving to an array of Responses. { schema } asks for JSON
   * matching it, parsed into response.data; { onEvent } sees every event.
   */
  async run(prompt, { stream, chat, onEvent, ...options } = {}) {
    stream ??= this.streamTo;
    chat ??= this.chatting;
    if (isMessages(prompt)) {
      if (!chat) throw new TypeError("an array of messages is a conversation: pass chat: true, or use runMany for separate prompts");
      const out = [];
      for (const p of prompt) out.push(await this.run(p, { stream, chat: true, onEvent, ...options }));
      return out;
    }
    if (chat) return this.#defaultChat(options).send(prompt, { stream });
    const o = this.#options(options);
    if (stream) return parsed(await deliver(this.#stream(prompt, o, onEvent), stream), o.schema);
    const t = await this.#task(prompt, o);
    const s = await this.#open(t, o, onEvent);
    try {
      return parsed(this.#count(await s.prompt(prompt)), o.schema);
    } finally {
      await s.close();
    }
  }

  /**
   * The answer as an async iterable of text chunks, for when you want to
   * handle each chunk yourself ({ stream: true } on run does it for you).
   */
  stream(prompt, { chat, onEvent, ...options } = {}) {
    chat ??= this.chatting;
    if (chat) return this.#defaultChat(options).stream(prompt);
    return this.#stream(prompt, this.#options(options), onEvent);
  }

  /** Ends the conversation that chat: true keeps; the next run starts a new one. */
  async reset() {
    const c = this.conversation;
    this.conversation = null;
    if (c) await c.close();
  }

  /**
   * Runs several prompts at once and resolves to their Responses in order.
   * Each item is a prompt, or { prompt, ...options } with its own options.
   * With { returnExceptions: true } a failed run gives its error in its place
   * instead of rejecting.
   */
  async runMany(prompts, { returnExceptions = false, maxConcurrency, ...options } = {}) {
    options = { chat: false, stream: false, ...options };
    const out = new Array(prompts.length);
    let next = 0;
    const worker = async () => {
      while (next < prompts.length) {
        const i = next++;
        const item = prompts[i];
        const [prompt, own] = typeof item === "object" && item !== null && "prompt" in item ? [item.prompt, { ...item, prompt: undefined }] : [item, {}];
        delete own.prompt;
        try {
          out[i] = await this.run(prompt, { ...options, ...own });
        } catch (err) {
          if (!returnExceptions) throw err;
          out[i] = err;
        }
      }
    };
    const n = Math.max(1, Math.min(maxConcurrency ?? this.maxConcurrency, prompts.length));
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  /** A conversation with one runtime that remembers what was said. */
  chat(options = {}) {
    return new Chat(this, this.#options(options));
  }

  /** The runtimes rbridge knows, with whether each is installed. */
  async runtimes() {
    const list = await (await this.client()).providers();
    return list.map((p) => ({
      id: p.id,
      name: p.display_name ?? p.id,
      available: p.runtime?.health === "available",
      version: p.runtime?.version,
      models: p.model_names ?? {},
    }));
  }

  /** The skills in rbridge's library, for a program to show or choose from. */
  async skills() {
    const list = await (await this.client()).skills();
    return list.map((s) => ({ id: s.id, description: s.description ?? "", trust: s.trust, version: s.version || null, scripts: Boolean(s.has_scripts) }));
  }

  /** Adds every skill in a folder (or several) and resolves to their ids; trusted as reviewed by default. */
  async addSkills(source, { trust = "reviewed", ...options } = {}) {
    const { items } = await (await this.client()).addSkills(source, { trust, ...options });
    const failed = items.filter((i) => i.status === "failed");
    if (failed.length) throw new RbridgeError("skill_invalid", failed.map((i) => `${i.id}: ${i.reason}`).join("; "));
    return items.filter((i) => i.status !== "skipped").map((i) => i.id);
  }

  /** @internal used by Chat */
  async _open(prompt, o, onEvent) {
    return this.#open(await this.#task(prompt, o), o, onEvent);
  }

  /** @internal used by Chat */
  _count(raw) {
    return this.#count(raw);
  }

  async close() {
    await this.reset();
    if (this.connection) (await this.connection).close();
    this.connection = null;
  }
}

/** A conversation: each send() continues the same session. */
export class Chat {
  constructor(rb, options) {
    this.rb = rb;
    this.options = options;
    this.session = null;
    this.sink = null;
    this.turn = Promise.resolve();
    this.seen = new Set();
    this.ended = new Set();
  }

  // Events from a turn that has ended (they can trail its result) never reach
  // the next turn's stream.
  #events(ev) {
    if (ev.turn_id) {
      if (this.ended.has(ev.turn_id)) return;
      this.seen.add(ev.turn_id);
    }
    this.sink?.(ev);
  }

  get id() {
    return this.session?.id ?? null;
  }

  #start(prompt) {
    return (sink) => {
      const run = this.turn.then(async () => {
        this.sink = sink;
        try {
          this.session ??= await this.rb._open(prompt, this.options, (ev) => this.#events(ev));
          const raw = await this.session.prompt(prompt);
          this.rb._count(raw);
          return raw;
        } finally {
          this.sink = null;
          for (const id of this.seen) this.ended.add(id);
        }
      });
      this.turn = run.catch(() => {});
      return run;
    };
  }

  /**
   * Sends a message and resolves to the Response; an array of messages is
   * sent in order and resolves to an array. { stream: true } prints the
   * answer as it is written (a function receives the chunks instead); the
   * default comes from new Rbridge({ stream }).
   */
  async send(prompt, { stream } = {}) {
    stream ??= this.rb.streamTo;
    if (isMessages(prompt)) {
      const out = [];
      for (const p of prompt) out.push(await this.send(p, { stream }));
      return out;
    }
    if (stream) return parsed(await deliver(this.stream(prompt), stream), this.options.schema);
    return parsed(new Response(await this.#start(prompt)(null)), this.options.schema);
  }

  /** The answer as an async iterable of text chunks. */
  stream(prompt) {
    return new Stream(this.#start(prompt));
  }

  async close() {
    await this.turn;
    if (this.session) await this.session.close();
    this.session = null;
  }
}
