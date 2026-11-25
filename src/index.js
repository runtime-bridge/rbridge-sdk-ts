// Client for the rbridge daemon. IPC (Unix domain socket, JSON-RPC) is the
// default; HTTP with Server-Sent Events is available when the daemon has it
// enabled. No dependencies beyond Node.js 20.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const PROTOCOL_VERSION = 1;

/** Error carrying one of rbridge's stable error codes. */
export class RbridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "RbridgeError";
    this.code = code;
    this.details = details ?? {};
  }
}

/** Builds a prompt of one text block. */
export function text(s) {
  return [{ type: "text", text: s }];
}

function toPrompt(p) {
  return typeof p === "string" ? text(p) : p;
}

/** The runtime directory the daemon uses, following rbridge's own rules. */
export function runtimeDir(env = process.env) {
  if (env.RBRIDGE_HOME) return path.join(env.RBRIDGE_HOME, "run");
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(env.LocalAppData || path.join(home, "AppData", "Local"), "rbridge", "run");
    case "darwin":
      return path.join(env.TMPDIR || "/tmp", `rbridge-${process.getuid()}`);
    default: {
      if (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)) return path.join(env.XDG_RUNTIME_DIR, "rbridge");
      const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
      return path.join(data, "rbridge", "run");
    }
  }
}

/**
 * The running daemon's socket. daemon.json records it, because the daemon
 * moves the socket to a short temp path when the runtime directory is too
 * deep for a Unix socket.
 */
export function socketPath(env = process.env) {
  const dir = runtimeDir(env);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, "daemon.json"), "utf8"));
    if (state.socket) return state.socket;
  } catch {
    // no daemon has written its state yet
  }
  return path.join(dir, "bridge.sock");
}

/**
 * Connects to the daemon over IPC.
 * @param {{socket?: string, client?: string, env?: object}} [options]
 */
export async function connect(options = {}) {
  const socket = options.socket ?? socketPath(options.env);
  const transport = await IPCTransport.open(socket);
  const client = new Client(transport);
  await transport.call("initialize", { client: options.client ?? "default", protocol_version: PROTOCOL_VERSION });
  return client;
}

/**
 * Connects to the daemon over HTTP. Without url and token, both are read from
 * the daemon's runtime directory.
 * @param {{url?: string, token?: string, client?: string, env?: object}} [options]
 */
export async function connectHTTP(options = {}) {
  let { url, token } = options;
  if (!url || !token) {
    const dir = runtimeDir(options.env);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "daemon.json"), "utf8"));
    url ??= state.http;
    token ??= fs.readFileSync(path.join(dir, "daemon.token"), "utf8").trim();
    if (!url) throw new RbridgeError("provider_unavailable", "the daemon has no HTTP listener; set daemon.http.enabled");
  }
  return new Client(new HTTPTransport(url, token, options.client ?? "default"));
}

class IPCTransport {
  static open(socket) {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(socket);
      conn.once("connect", () => resolve(new IPCTransport(conn)));
      conn.once("error", (err) =>
        reject(new RbridgeError("provider_unavailable", `no rbridge daemon at ${socket}: ${err.message}`)),
      );
    });
  }

  constructor(conn) {
    this.conn = conn;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.#dispatch(JSON.parse(line));
      }
    });
    const fail = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new RbridgeError("provider_unavailable", "connection to the daemon closed"));
      this.pending.clear();
    };
    conn.on("close", fail);
    conn.on("error", fail);
  }

  #dispatch(m) {
    if (m.method === "session.event") {
      const ev = m.params.event;
      this.listeners.get(ev.session_id)?.(ev);
      return;
    }
    if (m.method) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) {
      const d = m.error.data ?? {};
      p.reject(new RbridgeError(d.code ?? "internal_error", d.message ?? m.error.message, d.details));
    } else {
      p.resolve(m.result);
    }
  }

  call(method, params) {
    if (this.closed) return Promise.reject(new RbridgeError("provider_unavailable", "connection to the daemon closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.conn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    });
  }

  async subscribe(sessionId, onEvent) {
    this.listeners.set(sessionId, onEvent);
    await this.call("sessions.subscribe", { id: sessionId, after: 0 });
    return async () => {
      this.listeners.delete(sessionId);
      await this.call("sessions.unsubscribe", { id: sessionId }).catch(() => {});
    };
  }

  close() {
    this.conn.end();
  }
}

class HTTPTransport {
  constructor(url, token, client) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.client = client;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}`, "X-Rbridge-Client": this.client, "Content-Type": "application/json" };
  }

  async request(method, p, body) {
    const res = await fetch(this.url + p, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      const e = data.error ?? {};
      throw new RbridgeError(e.code ?? "internal_error", e.message ?? res.statusText, e.details);
    }
    return data;
  }

  call(method, params = {}) {
    const id = encodeURIComponent(params.id ?? "");
    switch (method) {
      case "providers.list":
        return this.request("GET", "/v1/providers" + (params.refresh ? "?refresh=true" : ""));
      case "skills.list":
        return this.request("GET", "/v1/skills");
      case "sessions.list":
        return this.request("GET", "/v1/sessions");
      case "sessions.get":
        return this.request("GET", `/v1/sessions/${id}`);
      case "sessions.open":
        return this.request("POST", "/v1/sessions", params);
      case "sessions.resume":
        return this.request("POST", `/v1/sessions/${id}/resume`, { model: params.model });
      case "sessions.prompt":
        return this.request("POST", `/v1/sessions/${id}/turns`, { prompt: params.prompt, wait: params.wait });
      case "sessions.cancel":
        return this.request("POST", `/v1/sessions/${id}/cancel`, {});
      case "sessions.close":
        return this.request("DELETE", `/v1/sessions/${id}`);
      case "approvals.answer":
        return this.request("POST", `/v1/sessions/${encodeURIComponent(params.session_id)}/approvals/${encodeURIComponent(params.approval_id)}`, params);
      case "daemon.status":
        return this.request("GET", "/v1/status");
    }
    return Promise.reject(new RbridgeError("invalid_input", `method ${method} is not available over HTTP`));
  }

  async subscribe(sessionId, onEvent) {
    const ctrl = new AbortController();
    const res = await fetch(`${this.url}/v1/sessions/${encodeURIComponent(sessionId)}/events`, { headers: this.headers(), signal: ctrl.signal });
    if (!res.ok) {
      const e = (await res.json()).error ?? {};
      throw new RbridgeError(e.code ?? "internal_error", e.message ?? res.statusText);
    }
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (data && !block.includes("event: end")) onEvent(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        // aborted on close
      }
    })();
    return async () => ctrl.abort();
  }

  close() {}
}

/** A client of the daemon. Its methods mirror the Go bridge.Client. */
export class Client {
  constructor(transport) {
    this.t = transport;
  }

  providers({ refresh = false } = {}) {
    return this.t.call("providers.list", { refresh });
  }

  skills() {
    return this.t.call("skills.list");
  }

  sessions() {
    return this.t.call("sessions.list");
  }

  status() {
    return this.t.call("daemon.status");
  }

  /**
   * Opens a session. options.onEvent receives every event; options.approver
   * decides approval requests (without one they are denied).
   */
  async open(task, options = {}) {
    const record = await this.t.call("sessions.open", { task: { ...task, prompt: task.prompt ? toPrompt(task.prompt) : undefined }, model: options.model });
    return this.#attach(record, options);
  }

  async resume(id, options = {}) {
    const record = await this.t.call("sessions.resume", { id, model: options.model });
    return this.#attach(record, options);
  }

  async #attach(record, options) {
    const session = new Session(this.t, record);
    session.unsubscribe = await this.t.subscribe(record.id, (ev) => {
      options.onEvent?.(ev);
      if (ev.type === "approval.required") this.#answer(record.id, ev.data, options.approver);
    });
    return session;
  }

  async #answer(sessionId, request, approver) {
    let allow = false;
    let optionId;
    let remember = false;
    if (approver) {
      try {
        const d = await approver(request);
        allow = d === true || d?.allow === true;
        optionId = typeof d === "object" ? d.optionId : undefined;
        remember = typeof d === "object" && d.remember === true;
      } catch {
        allow = false;
      }
    }
    await this.t.call("approvals.answer", { session_id: sessionId, approval_id: request.id, allow, option_id: optionId, remember }).catch(() => {});
  }

  /** Runs a task in a new session and closes it. */
  async run(task, options = {}) {
    const s = await this.open(task, options);
    try {
      return await s.prompt(task.prompt);
    } finally {
      await s.close();
    }
  }

  close() {
    this.t.close();
  }
}

/** A multi-turn session. */
export class Session {
  constructor(transport, record) {
    this.t = transport;
    this.record = record;
    this.id = record.id;
  }

  prompt(prompt) {
    return this.t.call("sessions.prompt", { id: this.id, prompt: toPrompt(prompt) });
  }

  cancel() {
    return this.t.call("sessions.cancel", { id: this.id });
  }

  async close() {
    await this.t.call("sessions.close", { id: this.id });
    await this.unsubscribe?.();
  }
}
