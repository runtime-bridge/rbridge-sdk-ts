# @rbridge/sdk

Node.js client for the [rbridge](https://github.com/runtime-bridge/rbridge) daemon. It lets a Node program hand tasks to the agent runtimes installed on the machine (Claude Code, OpenCode, any ACP agent) through one interface, with skills, approvals and streamed events.

No dependencies. Node.js 20 or later.

## Use

Start the daemon once (`rbridge daemon start`), then:

```js
import { connect } from "@rbridge/sdk";

const rb = await connect({ client: "my-app" });
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

`connect()` uses the daemon's Unix socket, found the same way rbridge finds it (`RBRIDGE_HOME`, XDG and OS defaults); pass `socket` to override. `connectHTTP()` uses the local HTTP API instead and reads the URL and token from the daemon's runtime directory; the daemon must have `daemon.http.enabled: true`.

| Call | What it does |
|---|---|
| `run(task, options)` | New session, one turn, close |
| `open(task, options)` / `resume(id, options)` | Session with `prompt()`, `cancel()`, `close()` |
| `providers()`, `skills()`, `sessions()`, `status()` | Read the daemon's state |

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
