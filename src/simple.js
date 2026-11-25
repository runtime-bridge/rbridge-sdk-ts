// The everyday API: Rbridge.
//
//   import { Rbridge } from "@rbridge/sdk";
//
//   const rb = new Rbridge({ runtime: "claude-code" });
//   console.log((await rb.run("Summarise README.md")).text);
//
//   for await (const chunk of await rb.run("Explain app.js", { stream: true })) process.stdout.write(chunk);
//
//   const chat = rb.chat();
//   await chat.send("What does app.js do?");
//   await chat.send("Now write tests for it");
//
//   const answers = await rb.runMany(["Review a.js", "Review b.js"]);
//
// Connections, sessions, events and approvals are handled here. The
// lower-level Client stays available as await rb.client() for anything this
// does not cover.

import fs from "node:fs";
import path from "node:path";

import { connect, RbridgeError } from "./index.js";

const OPTIONS = ["runtime", "model", "workspace", "skills", "profile", "approve", "sandbox", "timeout"];

/** What a runtime answered. */
export class Response {
  constructor(raw) {
    const u = raw.usage ?? {};
    this.text = raw.output ?? "";
    this.runtime = raw.provider ?? "";
    this.sessionId = raw.session_id ?? "";
    this.stopReason = raw.stop_reason ?? "";
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
 * rbridge choose), model, workspace (default: the current folder), skills
 * (ids, or folders of skills your program ships), profile ("observe" for
 * read-only, "standard", "controlled"), approve (false to deny permission
 * requests, true to allow, "read" for reads only, or a function), sandbox
 * ("files" or "full"), timeout (seconds), maxConcurrency for runMany, and
 * maxCostUsd, after which no new run starts.
 */
export class Rbridge {
  constructor({ maxConcurrency = 4, maxCostUsd, app = "default", env, client, ...defaults } = {}) {
    this.#check(defaults);
    this.defaults = { skills: [], approve: false, ...defaults };
    this.maxConcurrency = maxConcurrency;
    this.maxCostUsd = maxCostUsd;
    /** Tokens and cost across every run made through this object. */
    this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.app = app;
    this.env = env;
    this.connection = client ? Promise.resolve(client) : null;
    this.skillDirs = new Map();
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

  async #skillIds(skills) {
    const ids = [];
    for (const s of skills ?? []) {
      let isDir = false;
      try {
        isDir = fs.statSync(s).isDirectory();
      } catch {
        // an id, not a folder
      }
      if (!isDir) {
        ids.push(s);
        continue;
      }
      const abs = path.resolve(s);
      if (!this.skillDirs.has(abs)) {
        const { items } = await (await this.client()).addSkills(abs, { trust: "reviewed" });
        const failed = items.find((i) => i.status === "failed");
        if (failed) throw new RbridgeError("skill_invalid", `${failed.id}: ${failed.reason}`);
        if (items.length !== 1) throw new RbridgeError("invalid_input", `${s} holds ${items.length} skills; name one, or add them with addSkills`);
        this.skillDirs.set(abs, items[0].id);
      }
      ids.push(this.skillDirs.get(abs));
    }
    return ids;
  }

  async #task(prompt, o) {
    const t = { prompt, workspace: o.workspace };
    if (o.runtime) t.provider = o.runtime;
    if (o.skills?.length) t.skills = await this.#skillIds(o.skills);
    if (o.profile) t.profile = o.profile;
    if (o.sandbox) t.sandbox = o.sandbox;
    if (o.schema) t.output_schema = o.schema;
    if (o.timeout) t.timeout = Math.round(o.timeout * 1e9);
    return t;
  }

  #count(raw) {
    const r = new Response(raw);
    this.usage.inputTokens += r.usage.inputTokens;
    this.usage.outputTokens += r.usage.outputTokens;
    this.usage.costUsd = Math.round((this.usage.costUsd + r.usage.costUsd) * 1e6) / 1e6;
    return r;
  }

  async #open(t, o, onEvent) {
    return (await this.client()).open(t, { onEvent, approver: approver(o.approve), model: o.model });
  }

  /**
   * Runs one prompt in a new session. Resolves to a Response, or with
   * { stream: true } to a Stream to iterate. { schema } asks for JSON matching
   * it, parsed into response.data; { onEvent } sees every event as it happens.
   */
  async run(prompt, { stream = false, onEvent, ...options } = {}) {
    const o = this.#options(options);
    const t = await this.#task(prompt, o);
    const once = async (sink) => {
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
    };
    if (stream) return new Stream(once);
    return new Response(await once());
  }

  /**
   * Runs several prompts at once and resolves to their Responses in order.
   * Each item is a prompt, or { prompt, ...options } with its own options.
   * With { returnExceptions: true } a failed run gives its error in its place
   * instead of rejecting.
   */
  async runMany(prompts, { returnExceptions = false, maxConcurrency, ...options } = {}) {
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
    return list.map((p) => ({ id: p.id, name: p.display_name ?? p.id, available: p.runtime?.health === "available", version: p.runtime?.version }));
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

  /** Sends one message. Resolves to a Response, or with { stream: true } to a Stream. */
  async send(prompt, { stream = false } = {}) {
    const once = (sink) => {
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
    if (stream) return new Stream(once);
    return new Response(await once());
  }

  async close() {
    await this.turn;
    if (this.session) await this.session.close();
    this.session = null;
  }
}
