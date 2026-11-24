// Starts a real rbridge daemon whose only runtime is the fake ACP agent.
// RBRIDGE_BIN and RBRIDGE_FAKE_AGENT point at the binaries; by default they
// are taken from a sibling checkout of the rbridge repo (make build fakeagent).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = path.resolve(here, "..", "..", "rbridge", "bin");
export const RBRIDGE_BIN = process.env.RBRIDGE_BIN ?? path.join(sibling, "rbridge");
export const FAKE_AGENT = process.env.RBRIDGE_FAKE_AGENT ?? path.join(sibling, "rbridge-fakeagent");

export async function startDaemon(scenario = "echo") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rbts-"));
  const workspace = path.join(home, "ws");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "config", "config.yaml"),
    [
      "version: 1",
      "providers:",
      "  order: [fake]",
      "  custom:",
      "    - id: fake",
      `      launch: { command: ${JSON.stringify(FAKE_AGENT)}, env_passthrough: [RBRIDGE_FAKE_ACP_SCENARIO] }`,
      "      version_args: [--version]",
      "daemon:",
      "  http: { enabled: true, port: 0 }",
      "  requests_per_second: 1000",
      "execution:",
      "  kill_grace_period: 1s",
      "",
    ].join("\n"),
  );
  const env = { ...process.env, RBRIDGE_HOME: home, RBRIDGE_FAKE_ACP_SCENARIO: scenario };
  const proc = spawn(RBRIDGE_BIN, ["daemon", "run"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const stateFile = path.join(home, "run", "daemon.json");
  for (let i = 0; i < 100 && !fs.existsSync(stateFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(stateFile)) throw new Error("daemon did not start: " + stderr);
  return {
    home,
    workspace,
    env: { RBRIDGE_HOME: home },
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
