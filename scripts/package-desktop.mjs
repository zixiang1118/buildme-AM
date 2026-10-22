import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(join(tmpdir(), "piharness-desktop-"));
const appName = "BuildMe";
const platform = process.argv.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length) ?? process.env.BUILDME_PLATFORM ?? "darwin";
const arch = process.argv.find((arg) => arg.startsWith("--arch="))?.slice("--arch=".length) ?? process.env.BUILDME_ARCH ?? (platform === "darwin" ? "arm64" : "x64");

if (!new Set(["darwin", "win32"]).has(platform)) {
  throw new Error(`Unsupported desktop packaging platform: ${platform}`);
}

const releaseDirectory = join(root, "release", `${appName}-${platform}-${arch}`);
const packagedApp = platform === "darwin"
  ? join(releaseDirectory, `${appName}.app`)
  : join(releaseDirectory, `${appName}.exe`);

async function canonicalPath(path) {
  let cursor = resolve(path); const suffix = [];
  for (;;) {
    try { return resolve(await realpath(cursor), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(cursor) === cursor) throw error;
      suffix.push(basename(cursor)); cursor = dirname(cursor);
    }
  }
}
async function requireOwnedPath(parent, target) {
  const path = relative(await canonicalPath(parent), await canonicalPath(target));
  if (!path || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path)) throw new Error(`Packaging path escapes its output directory: ${target}`);
}
await requireOwnedPath(root, join(root, "release"));
await requireOwnedPath(join(root, "release"), releaseDirectory);
const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const require = createRequire(import.meta.url);

async function existingCli(path) {
  return path && /(?:pnpm\.(?:c?js|mjs))$/iu.test(path) && (await stat(path).catch(() => null))?.isFile() ? resolve(path) : null;
}
async function pnpmCliPath() {
  const invoked = await existingCli(process.env.npm_execpath);
  const isCorepack = (path) => /[\\/]corepack[\\/]dist[\\/]pnpm\.js$/iu.test(path);
  if (invoked && !isCorepack(invoked)) return invoked;
  const candidates = [];
  const corepackCandidates = invoked ? [invoked] : [];
  try {
    const packagePath = require.resolve("pnpm/package.json");
    const metadata = JSON.parse(await readFile(packagePath, "utf8"));
    candidates.push(join(dirname(packagePath), typeof metadata.bin === "string" ? metadata.bin : metadata.bin.pnpm));
  } catch { /* A globally installed pnpm need not be a project dependency. */ }
  for (const nodeRoot of [dirname(process.execPath), resolve(dirname(process.execPath), "..")]) {
    for (const entry of ["pnpm/bin/pnpm.mjs", "pnpm/bin/pnpm.cjs", "pnpm/bin/pnpm.js"]) candidates.push(join(nodeRoot, "node_modules", entry));
    corepackCandidates.push(join(nodeRoot, "node_modules", "corepack/dist/pnpm.js"));
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["pnpm", "pnpm.cmd", "pnpm.ps1"]) {
      const shim = join(directory.replace(/^"|"$/gu, ""), name);
      const resolved = await realpath(shim).catch(() => null);
      if (resolved) candidates.push(resolved);
      const body = await readFile(shim, "utf8").catch(() => "");
      if (body.length > 32 * 1024) continue;
      for (const match of body.matchAll(/(?:%~dp0|%dp0%|\$basedir)([^"'\r\n]*pnpm\.(?:c?js|mjs))/giu)) candidates.push(resolve(dirname(shim), match[1].replace(/^[\\/]+/u, "")));
    }
  }
  for (const candidate of [...new Set(candidates.filter((path) => !isCorepack(path)))]) { const cli = await existingCli(candidate); if (cli) return cli; }
  for (const candidate of [...new Set([...candidates.filter(isCorepack), ...corepackCandidates])]) { const cli = await existingCli(candidate); if (cli) return cli; }
  throw new Error("无法定位 pnpm 的 JavaScript CLI 入口。请从已安装的 pnpm 运行 desktop:package 命令。");
}
async function packagerCliPath() {
  const packagePath = require.resolve("@electron/packager/package.json");
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  const cli = join(dirname(packagePath), typeof metadata.bin === "string" ? metadata.bin : metadata.bin["electron-packager"]);
  if (!(await stat(cli)).isFile()) throw new Error("Electron Packager 的 JavaScript CLI 不存在。");
  return cli;
}

function command(program, args, environment = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env, ...environment } });
    child.once("error", rejectCommand);
    child.once("exit", (code) => {
      if (code === 0) resolveCommand();
      else rejectCommand(new Error(`${program} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function createProductionStage() {
  await mkdir(join(stage, "scripts"), { recursive: true });
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  delete packageJson.devDependencies;
  packageJson.scripts = {};
  await Promise.all([
    cp(join(root, "dist"), join(stage, "dist"), { recursive: true }),
    cp(join(root, "desktop"), join(stage, "desktop"), { recursive: true }),
    cp(join(root, "bundles", "base"), join(stage, "bundles", "base"), { recursive: true }),
    cp(join(root, "legal"), join(stage, "legal"), { recursive: true }),
    cp(join(root, "LICENSE"), join(stage, "LICENSE")),
    cp(join(root, "THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md")),
    cp(join(root, "pnpm-lock.yaml"), join(stage, "pnpm-lock.yaml")),
    cp(join(root, "pnpm-workspace.yaml"), join(stage, "pnpm-workspace.yaml")),
    cp(join(root, ".npmrc"), join(stage, ".npmrc")),
    writeFile(join(stage, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8"),
  ]);
  await command(process.execPath, [await pnpmCliPath(), "--dir", stage, "install", "--prod", "--config.node-linker=hoisted"], { COREPACK_ENABLE_AUTO_PIN: "0", COREPACK_ENABLE_NETWORK: "0", pnpm_config_pm_on_fail: "ignore" });
}

async function packageDesktop() {
  await createProductionStage();
  const icon = platform === "win32"
    ? join(root, "desktop", "assets", "icon.ico")
    : join(root, "desktop", "assets", "icon.icns");
  await command(process.execPath, [await packagerCliPath(),
    stage,
    appName,
    `--platform=${platform}`,
    `--arch=${arch}`,
    "--electron-version=43.4.0",
    "--app-bundle-id=local.personal.agent",
    `--out=${join(root, "release")}`,
    "--overwrite",
    "--asar.unpack=**/*.{node,dylib,py,ps1}",
    `--icon=${icon}`,
  ]);

  if (platform === "darwin") {
    // electron-packager 18 may skip .icns on newer macOS releases in favor of
    // the new .icon format. Keep the generated cube artwork authoritative by
    // replacing the packaged fallback before signing.
    await cp(join(root, "desktop", "assets", "icon.icns"), join(packagedApp, "Contents", "Resources", "electron.icns"));
    await command("codesign", ["--force", "--deep", "--sign", "-", packagedApp]);
    console.log(`已生成：${packagedApp}`);
  } else {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const archive = join(root, "release", `${appName}-${packageJson.version}-${platform}-${arch}.zip`);
    await requireOwnedPath(join(root, "release"), archive);
    await rm(archive, { force: true });
    if (process.platform === "win32") {
      await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${psLiteral(releaseDirectory)} -DestinationPath ${psLiteral(archive)} -CompressionLevel Optimal`]);
    } else await command("ditto", ["-c", "-k", "--keepParent", releaseDirectory, archive]);
    const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
    await writeFile(`${archive}.sha256`, `${checksum}  ${basename(archive)}\n`, "utf8");
    console.log(`已生成：${packagedApp}`);
    console.log(`Windows 分发包：${archive}`);
    console.log(`SHA-256：${archive}.sha256`);
  }
}
try {
  if (process.argv.includes("--verify-cli")) {
    console.log(`打包目标：${platform}/${arch}`);
    await command(process.execPath, [await pnpmCliPath(), "--version"], { COREPACK_ENABLE_AUTO_PIN: "0", COREPACK_ENABLE_NETWORK: "0", pnpm_config_pm_on_fail: "ignore" });
    await command(process.execPath, [await packagerCliPath(), "--version"]);
  } else await packageDesktop();
} finally {
  await requireOwnedPath(tmpdir(), stage);
  if (!basename(stage).startsWith("piharness-desktop-")) throw new Error(`Unexpected packaging stage: ${stage}`);
  await rm(stage, { recursive: true, force: true });
}
