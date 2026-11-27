<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/runtime-bridge/rbridge/main/docs/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/runtime-bridge/rbridge/main/docs/assets/logo-light.png" alt="rbridge" width="220">
  </picture>
</p>

# @rbridge/sdk

Node.js client for the [rbridge](https://github.com/runtime-bridge/rbridge) daemon. It lets a Node program hand tasks to the agent runtimes installed on the machine (Claude Code, OpenCode, any ACP agent) through one interface, with skills, approvals and streamed events.

No dependencies. Node.js 20 or later.

Documentation and examples: <https://runtime-bridge.github.io/docs/sdks/>.

## Install

Two ways, depending on where you want rbridge to live:

| | Command | rbridge lives | Its data lives | Removed by |
|---|---|---|---|---|
| **With the SDK** (per project) | `npm install @rbridge/sdk` in the project | In `node_modules`, as an `rbridge` command (`npx rbridge`) | The project's `.rbridge` folder | `npm uninstall @rbridge/sdk`, or deleting `node_modules`; delete `.rbridge` for the data |
| **On its own** (whole machine) | rbridge's [install script](https://github.com/runtime-bridge/rbridge#install), then the SDK from Git | On your `PATH`, for every project | Your user folders | `rbridge uninstall --yes` (add `--purge` for the data) |

The published package depends on one optional package per platform (`@rbridge/linux-x64`, `-darwin-arm64`, `-win32-x64` and so on, x86-64 and ARM) and npm installs only the one for your machine. On any other platform the SDK uses an rbridge installed on its own.

With rbridge in `node_modules`, `RBRIDGE_HOME` (when set) still decides where the data goes. Otherwise the project is the folder holding `node_modules`. A global `npm install -g` counts as global and uses your user folders.

Until the packages are published, install from Git (`npm install github:runtime-bridge/rbridge-sdk-ts`, the client only; rbridge on its own), or build the packages yourself: `make cross` in the rbridge repository, then `node scripts/build-packages.mjs --binaries ../rbridge/bin` here, and `npm pack` the folders in `dist/`.

## Use

```js
import { Rbridge } from "@rbridge/sdk";

const rb = new Rbridge({ runtime: "claude-code" });

console.log((await rb.run("Summarise README.md")).text);
```

That is all the setup there is: `new Rbridge()` finds rbridge (or the copy that came with this package), starts its daemon if it is not running, and the workspace is the current folder. `runtime` is any id from `await rb.runtimes()`, such as `claude-code`, `opencode` or `codex`; leave it out and rbridge picks one.

**Stream** the answer as it is written. It is printed for you, and `run` still resolves to the whole answer:

```js
await rb.run("Explain app.js", { stream: true });
```

**Set it all once.** Options given to `new Rbridge({...})` apply to every call. With `chat: true` each `run` continues the same conversation, and an array sends several messages in one call:

```js
const rb = new Rbridge({ runtime: "claude-code", chat: true, stream: true });

await rb.run("What does app.js do?");
await rb.run("Now write tests for it");
await rb.run(["Summarise the tests", "Shorter"]);
await rb.reset();                              // start a new conversation
```

Any call can still override a default (`rb.run("...", { stream: false })`), and `rb.chat()` gives a separate conversation object when you want several at once (`chat.send(...)`). A program exits by itself when its work is done, and conversations still open are closed on the way out, so they never hold rbridge's slots afterwards; `rb.reset()` or `rb.close()` ends them sooner.

To handle the chunks yourself, pass a function, `{ stream: (chunk) => ... }`, or take the iterator, `for await (const chunk of rb.stream("..."))`.

**Run several at once**, in order. When rbridge is full (its session slots, or the per-client limit), runs wait their turn instead of failing, and errors rbridge marks as retryable are retried:

```js
const answers = await rb.runMany(["Review a.js", "Review b.js", "Review c.js"]);
// or with your own control: await Promise.all([rb.run("Review a.js"), rb.run("Review b.js")])
```

**Structured output**, parsed for you. A JSON schema works, and so does a schema object with `toJSONSchema()` and `parse()` (Zod's shape), which sets `parsed`:

```js
const r = await rb.run("List the TODOs in this project", { schema: { type: "object", properties: { todos: { type: "array", items: { type: "string" } } } } });
console.log(r.data.todos);
```

**Documents**, as paths or uploads. rbridge puts them in a working folder of their own for the run, gives Word files a text copy, and tells the runtime about them:

```js
await rb.run("Summarise these", { files: ["report.pdf", "bill.docx"] });

app.post("/summarise", async (req, res) => {                 // with a form upload
  const file = (await req.formData()).get("file");           // a File
  res.json({ text: (await rb.run("Summarise this", { files: [file] })).text });
});
```

**Skills** your program ships are named by folder (added and trusted on first use), and `rb.skills()` lists the library, for a page that lets people choose:

```js
await rb.run("Review this", { skills: ["./skills/security-review"] });
for (const s of await rb.skills()) console.log(s.id, s.description);
```

### Options

Every option can be set on `new Rbridge({...})` as a default and overridden on any call:

| Option | Meaning |
|---|---|
| `runtime` | Which runtime: an id from `runtimes()`; unset lets rbridge pick |
| `model` | `"latest"` (the runtime's newest flagship), `"auto"` (its own recommended choice), or a model name the runtime accepts; unset uses its configured default. `runtimes()` lists each runtime's names, and `response.model` says which model ran |
| `files` | Paths, `{ name, data }` objects, or `File` and `Blob` objects from a form |
| `workspace` | The folder the runtime works in; default the current folder, or with files a folder rbridge makes for them |
| `skills` | Skill ids, or folders of skills your program ships (rbridge adds and trusts them on first use) |
| `schema` | A JSON schema, or a schema with `toJSONSchema()` and `parse()`; the answer is in `data`, and parsed in `parsed` |
| `profile` | `observe` (read-only), `standard` or `controlled` |
| `approve` | When the runtime asks permission: `false` deny (default), `true` allow, `"read"` reads only, or a function given the request |
| `sandbox` | `files` or `full`, on Linux |
| `timeout` | Seconds per run |
| `queueTimeout` | Seconds a run may wait for rbridge to have room; unset waits as long as it takes, so runs queue instead of failing |
| `maxConcurrency` | How many `runMany` runs go at once (rbridge still applies its own limits) |
| `maxCostUsd` | After this much is spent, no new run starts (`rb.usage` has the running total) |
| `stream` | `true` prints answers as they are written; a function receives the chunks instead |
| `chat` | `true` makes every `run` continue one conversation |

A `Response` has `text`, `data` (with a schema), `runtime`, `model`, `sessionId`, `stopReason`, `usage` and `raw`. The `Stream` from `rb.stream()` yields text; afterwards `stream.response` is the `Response` and `stream.events` every event (tools, plans, usage). Pass `onEvent` to `run` to see events as they happen. Errors are `RbridgeError` with a stable `code` (the list is at https://runtime-bridge.github.io/docs/errors/); `budget_exceeded` means `maxCostUsd` is spent. Call `rb.close()` when you are done.

## Lower-level API

`await rb.client()` (or `connect()`) is the client underneath, for sessions you drive yourself, approvals with options, questions the runtime asks, modes and the daemon's state:

```js
import { connect } from "@rbridge/sdk";

const c = await connect({ client: "my-app" });
const result = await c.run(
  { workspace: "/home/me/project", prompt: "Review this project for security issues", skills: ["security-audit"] },
  {
    onEvent: (e) => e.type === "message.delta" && process.stdout.write(e.data.text),
    approver: async (req) => req.kind === "read",
  },
);
console.log(result.output);
c.close();
```

`connect()` starts a daemon when none is running (one that stops by itself after 30 idle minutes); pass `start: false` to only connect to a running one. It uses the daemon's Unix socket, found the same way rbridge finds it (`RBRIDGE_HOME`, XDG and OS defaults); pass `socket` to override. `connectHTTP()` uses the local HTTP API instead and reads the URL and token from the daemon's runtime directory; the daemon must have `daemon.http.enabled: true`.

| Call | What it does |
|---|---|
| `run(task, options)` | New session, one turn, close |
| `open(task, options)` / `resume(id, options)` | Session with `prompt()`, `cancel()`, `close()` |
| `providers()`, `skills()`, `sessions()`, `status()` | Read the daemon's state |
| `addSkill(dir)`, `setSkillTrust(id, trust)` | Add a skill your application ships and mark it reviewed |
| `addSkills(dirs, { only, exclude, trust, dryRun })` | Add every skill found in one or more folders (or a Git repository), with filters |
| `searchSkills(query)`, `addCatalogSkill(ref)` | Use configured skill catalogs |

`options.onEvent` receives every event (`message.delta`, `tool.started`, `approval.required`, `turn.completed`, ...). `options.approver` answers permission requests the policy profile leaves to the caller; return `true`, `false` or `{ allow, optionId, remember }`, where `remember` allows the same kind of request for the rest of the session. Without an approver such requests are denied. Errors are `RbridgeError` with rbridge's stable `code`.

`options.onInput` answers questions the runtime asks the user, as a form (`request.schema`) or a page to open (`request.url`, which rbridge never opens): return `{ action: "accept", content }`, `{ action: "decline" }` or `{ action: "cancel" }`. Without it such questions are declined.

ACP runtimes that offer session modes and settings expose them on the session; Claude Code does not, as its permission modes could bypass policy:

```js
const s = await client.open({ workspace: "/path/to/project" }, { mode: "code" });
console.log(await s.modes());           // { current: "code", modes: [...] }
await s.setOption("model", "large");
```

Sessions are visible only to the `client` name that opened them.

## Develop

Tests start a real daemon whose only runtime is rbridge's fake ACP agent. Build both in a sibling rbridge checkout (`make build fakeagent`), or point `RBRIDGE_BIN` and `RBRIDGE_FAKE_AGENT` at them, then:

```sh
npm test
```

The type declarations in `src/index.d.ts` are written by hand.

## License

Apache 2.0.
