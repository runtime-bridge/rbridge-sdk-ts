// Builds the packages to publish:
//
//   node scripts/build-packages.mjs --binaries ../rbridge/bin --out dist
//
// --binaries is a folder of rbridge builds named as `make cross` in the
// rbridge repository names them (rbridge-linux-amd64, rbridge-windows-arm64.exe
// and so on). It writes:
//
//   dist/sdk                        the SDK, with the rbridge command and one
//                                   optional dependency per platform
//   dist/<platform>-<arch>          one package per platform with its binary,
//                                   limited to that platform by os and cpu
//
// The package.json in the repository stays a plain client, so installing the
// SDK from Git works without any of these.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.binaries) {
  console.error("usage: node scripts/build-packages.mjs --binaries DIR [--out DIR]");
  process.exit(2);
}
const out = path.resolve(args.out ?? path.join(root, "dist"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const scope = pkg.name.split("/")[0];

// [Go os, Go arch, npm platform, npm arch]
const targets = [
  ["linux", "amd64", "linux", "x64"],
  ["linux", "arm64", "linux", "arm64"],
  ["darwin", "amd64", "darwin", "x64"],
  ["darwin", "arm64", "darwin", "arm64"],
  ["windows", "amd64", "win32", "x64"],
  ["windows", "arm64", "win32", "arm64"],
];

fs.rmSync(out, { recursive: true, force: true });
const optional = {};
for (const [goos, goarch, platform, arch] of targets) {
  const ext = goos === "windows" ? ".exe" : "";
  const src = path.join(args.binaries, `rbridge-${goos}-${goarch}${ext}`);
  if (!fs.existsSync(src)) {
    console.error(`skip ${platform}-${arch}: no ${src}`);
    continue;
  }
  const name = `${scope}/${platform}-${arch}`;
  const dir = path.join(out, `${platform}-${arch}`);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.copyFileSync(src, path.join(dir, "bin", "rbridge" + ext));
  fs.chmodSync(path.join(dir, "bin", "rbridge" + ext), 0o755);
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: pkg.version,
        description: `The rbridge program for ${platform} ${arch}, installed by ${pkg.name}`,
        license: pkg.license,
        repository: pkg.repository,
        os: [platform],
        cpu: [arch],
        files: ["bin", "LICENSE"],
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n\nThe rbridge binary for ${platform} ${arch}. Install [${pkg.name}](https://www.npmjs.com/package/${pkg.name}) instead; it brings the right one for your machine.\n`);
  optional[name] = pkg.version;
  console.log(path.relative(root, dir));
}

const sdk = path.join(out, "sdk");
for (const f of ["src", "bin"]) fs.cpSync(path.join(root, f), path.join(sdk, f), { recursive: true });
for (const f of ["LICENSE", "README.md"]) fs.copyFileSync(path.join(root, f), path.join(sdk, f));
fs.writeFileSync(
  path.join(sdk, "package.json"),
  JSON.stringify({ ...pkg, bin: { rbridge: "bin/rbridge.js" }, files: ["src", "bin", "LICENSE", "README.md"], optionalDependencies: optional, scripts: undefined }, null, 2) + "\n",
);
console.log(path.relative(root, sdk));
