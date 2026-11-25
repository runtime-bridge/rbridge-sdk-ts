// The rbridge program that ships with this package, and where it keeps data.
//
// Published builds depend on one optional package per platform, such as
// @rbridge/linux-x64, holding the rbridge binary; npm installs
// only the one that matches the machine. Installed into a project, that copy
// belongs to the project: it is used instead of any rbridge on PATH, and its
// configuration, skills, sessions and audit log live in the project's
// .rbridge folder. Removing the package (or node_modules) removes the
// program; deleting .rbridge removes the data.
//
// Without a platform package (installed from Git, or an unsupported
// platform), the SDK talks to whatever rbridge daemon the environment points
// at, as before.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RbridgeError } from "./index.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/** The platform package for this machine, as npm names platforms. */
export const platformPackage = `@rbridge/${process.platform}-${process.arch}`;

/** The rbridge program from this machine's platform package, or null. */
export function bundledBinary() {
  let dir;
  try {
    dir = path.dirname(require.resolve(`${platformPackage}/package.json`));
  } catch {
    return null;
  }
  const bin = path.join(dir, "bin", process.platform === "win32" ? "rbridge.exe" : "rbridge");
  if (!fs.existsSync(bin)) return null;
  if (process.platform !== "win32") {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      // Some package managers drop the executable bit.
      fs.chmodSync(bin, fs.statSync(bin).mode | 0o111);
    }
  }
  return bin;
}

function onPath(env, skip) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || (skip && skip(dir))) continue;
    for (const ext of exts) {
      const p = path.join(dir, "rbridge" + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** RBRIDGE_BIN, else the bundled program, else rbridge on PATH (outside node_modules). */
export function findBinary(env = process.env) {
  if (env.RBRIDGE_BIN) return env.RBRIDGE_BIN;
  return bundledBinary() ?? onPath(env, (dir) => dir.split(path.sep).includes("node_modules"));
}

/**
 * The project this package is installed in: the folder holding the outermost
 * node_modules it sits in, when that folder has a package.json. A global npm
 * install has none, and is treated as global.
 */
export function projectDir(from = here) {
  const parts = path.resolve(from).split(path.sep);
  const i = parts.indexOf("node_modules");
  if (i <= 0) return null;
  const dir = parts.slice(0, i).join(path.sep) || path.sep;
  return fs.existsSync(path.join(dir, "package.json")) ? dir : null;
}

/** The .rbridge folder a bundled rbridge uses when RBRIDGE_HOME is not set. */
export function projectHome() {
  if (!bundledBinary()) return null;
  const dir = projectDir();
  return dir ? path.join(dir, ".rbridge") : null;
}

/** The environment with RBRIDGE_HOME defaulted to the project home when rbridge is bundled. */
export function effectiveEnv(env = process.env) {
  const out = { ...env };
  if (!out.RBRIDGE_HOME) {
    const home = projectHome();
    if (home) out.RBRIDGE_HOME = home;
  }
  return out;
}

/** How long a daemon the SDK starts itself keeps running with nothing to do. */
export const AUTO_DAEMON_IDLE = "30m";

/**
 * Starts the daemon for this environment's rbridge home, if none is running.
 * It stops by itself after exitWhenIdle with no session and no client (null
 * keeps it running until rbridge daemon stop).
 */
export function startDaemon(env, exitWhenIdle = AUTO_DAEMON_IDLE) {
  env = effectiveEnv(env);
  const bin = findBinary(env);
  if (!bin) {
    throw new RbridgeError(
      "provider_unavailable",
      "no rbridge daemon is running and rbridge is not installed. Install it with the SDK " +
        "(npm install @rbridge/sdk, on Linux, macOS or Windows) or on its own " +
        "(https://github.com/runtime-bridge/rbridge#install), or set RBRIDGE_BIN to its path",
    );
  }
  const args = ["daemon", "start", ...(exitWhenIdle ? ["--exit-when-idle", exitWhenIdle] : [])];
  const run = spawnSync(bin, args, { env, encoding: "utf8", timeout: 60000 });
  if (run.status !== 0) {
    throw new RbridgeError(
      "provider_unavailable",
      `could not start the rbridge daemon: ${(run.stderr || run.stdout || String(run.error)).trim()}`,
    );
  }
}
