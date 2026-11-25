<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/runtime-bridge/rbridge/main/docs/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/runtime-bridge/rbridge/main/docs/assets/logo-light.png" alt="rbridge" width="220">
  </picture>
</p>

# @runtime-bridge/sdk

Node.js client for the [rbridge](https://github.com/runtime-bridge/rbridge) daemon. It lets a Node program hand tasks to the agent runtimes installed on the machine (Claude Code, OpenCode, any ACP agent) through one interface, with skills, approvals and streamed events.

No dependencies. Node.js 20 or later.

Documentation and examples: <https://runtime-bridge.github.io/docs/sdks/>.

## Install

Two ways, depending on where you want rbridge to live:

| | Command | rbridge lives | Its data lives | Removed by |
|---|---|---|---|---|
| **With the SDK** (per project) | `npm install @runtime-bridge/sdk` in the project | In `node_modules`, as an `rbridge` command (`npx rbridge`) | The project's `.rbridge` folder | `npm uninstall @runtime-bridge/sdk`, or deleting `node_modules`; delete `.rbridge` for the data |
| **On its own** (whole machine) | rbridge's [install script](https://github.com/runtime-bridge/rbridge#install), then the SDK from Git | On your `PATH`, for every project | Your user folders | `rbridge uninstall --yes` (add `--purge` for the data) |

The published package depends on one optional package per platform (`@runtime-bridge/rbridge-linux-x64`, `-darwin-arm64`, `-win32-x64` and so on, x86-64 and ARM) and npm installs only the one for your machine. On any other platform the SDK uses an rbridge installed on its own.

With rbridge in `node_modules`, `RBRIDGE_HOME` (when set) still decides where the data goes. Otherwise the project is the folder holding `node_modules`. A global `npm install -g` counts as global and uses your user folders.

Until the packages are published, install from Git (`npm install github:runtime-bridge/rbridge-sdk-ts`, the client only; rbridge on its own), or build the packages yourself: `make cross` in the rbridge repository, then `node scripts/build-packages.mjs --binaries ../rbridge/bin` here, and `npm pack` the folders in `dist/`.

## Use

```js
import { connect } from "@runtime-bridge/sdk";

const rb = await connect({ client: "my-app", start: true });
const result = await rb.run(
  { workspace: "/home/me/project", prompt: "Review this project for security issues", skills: ["security-audit"] },
  {
    onEvent: (e) => e.type === "message.delta" && process.stdout.write(e.data.text),
    approver: async (req) => req.kind === "read", // anything else is denied
  },
);
console.log(result.output);
rb.close();
```

`start: true` starts the daemon when it is not running, using the bundled rbridge (or `RBRIDGE_BIN`, or rbridge on `PATH`); without it, start the daemon yourself with `rbridge daemon start`. `connect()` uses the daemon's Unix socket, found the same way rbridge finds it (`RBRIDGE_HOME`, XDG and OS defaults); pass `socket` to override. `connectHTTP()` uses the local HTTP API instead and reads the URL and token from the daemon's runtime directory; the daemon must have `daemon.http.enabled: true`.

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
