#!/usr/bin/env node
// The rbridge command this package installs into node_modules/.bin. It runs
// the bundled program with RBRIDGE_HOME defaulted to the project's .rbridge
// folder, so rbridge inside the project uses the project's copy and data.

import { spawnSync } from "node:child_process";

import { bundledBinary, effectiveEnv, platformPackage } from "../src/bundle.js";

const bin = bundledBinary();
if (!bin) {
  process.stderr.write(`rbridge: ${platformPackage} is not installed, so there is no bundled rbridge for this machine; install rbridge itself\n`);
  process.exit(127);
}
const env = effectiveEnv();
env.RBRIDGE_BUNDLED = "node:" + new URL("..", import.meta.url).pathname;
const run = spawnSync(bin, process.argv.slice(2), { env, stdio: "inherit" });
if (run.error) {
  process.stderr.write(`rbridge: ${run.error.message}\n`);
  process.exit(127);
}
process.exit(run.status ?? (run.signal ? 128 : 1));
