#!/usr/bin/env bun
import { $ } from "bun";
import { cac } from "cac";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// If you need env types similar to EnumType in cliffy, you can handle validation manually
const VALID_ENVS = ["linux", "windows", "macos"];

interface Env {
  binary: string;
}

const DEFAULT_BINARY = "dinosaur-game";
// Keep stable build tools pinned here. Trunk's official release artifacts are
// locked to these checksums so installs do not depend on Cargo's live resolver
// or the host C compiler.
const TRUNK_VERSION = "0.21.14";
const BINARYEN_VERSION = "version_119";

interface TrunkArtifact {
  archive: string;
  sha256: string;
}

const TRUNK_ARTIFACTS: Record<string, TrunkArtifact> = {
  "darwin-arm64": {
    archive: "trunk-aarch64-apple-darwin.tar.gz",
    sha256: "764e299dd50d89442a4e96a236349f57961984b701e74d3dbdb39cd1c9f5101e",
  },
  "darwin-x64": {
    archive: "trunk-x86_64-apple-darwin.tar.gz",
    sha256: "f1ba0e3bbe24e0ae219c6d22c33e24e2825c1608dd27c2556e323495110f1a95",
  },
  "linux-arm64": {
    archive: "trunk-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "b1d8e60e454f7fc182d9a4d95d1506ffbae947d8ba90f8f6f02da93b60f980f9",
  },
  "linux-x64": {
    archive: "trunk-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "f2b4680cd239693a646a2795e4633c625328d7b2a044fbe749fa3a2fe9e7036b",
  },
  "win32-x64": {
    archive: "trunk-x86_64-pc-windows-msvc.zip",
    sha256: "cd6ac15b9daff0365e5695036791ef2ce3c63f61c014f5a8c532363266e4569c",
  },
};

async function installLinuxDeps() {
  await $`sudo apt-get update`;
  await $`sudo apt-get install -y --no-install-recommends pkg-config libx11-dev libasound2-dev libudev-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev clang mold libwayland-dev libxkbcommon-dev`;
}

async function installTrunk() {
  const expectedVersion = `trunk ${TRUNK_VERSION}`;
  const installed = await $`trunk --version`.quiet().nothrow();
  if (installed.exitCode === 0 && installed.stdout.toString().trim() === expectedVersion) {
    console.log(`${expectedVersion} is already installed`);
    return;
  }

  const artifact = TRUNK_ARTIFACTS[`${process.platform}-${process.arch}`];
  if (!artifact) {
    throw new Error(`No pinned Trunk artifact for ${process.platform}-${process.arch}`);
  }

  const url = `https://github.com/trunk-rs/trunk/releases/download/v${TRUNK_VERSION}/${artifact.archive}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  const actualHash = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex");
  if (actualHash !== artifact.sha256) {
    throw new Error(
      `Checksum mismatch for ${artifact.archive}: expected ${artifact.sha256}, got ${actualHash}`,
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "dinosaur-game-trunk-"));
  try {
    const archivePath = join(tempDir, artifact.archive);
    await Bun.write(archivePath, archiveBytes);

    if (process.platform === "win32") {
      await $`powershell -NoProfile -Command Expand-Archive -LiteralPath ${archivePath} -DestinationPath ${tempDir} -Force`;
    } else {
      await $`tar -xzf ${archivePath} -C ${tempDir}`;
    }

    const executableName = process.platform === "win32" ? "trunk.exe" : "trunk";
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
    const binDir = join(cargoHome, "bin");
    const installedPath = join(binDir, executableName);
    await mkdir(binDir, { recursive: true });
    await copyFile(join(tempDir, executableName), installedPath);
    if (process.platform !== "win32") {
      await chmod(installedPath, 0o755);
    }

    const version = (await $`${installedPath} --version`.text()).trim();
    if (version !== expectedVersion) {
      throw new Error(`Installed unexpected Trunk version: ${version}`);
    }
    console.log(`Installed ${version} at ${installedPath}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function installWasmDeps() {
  if (process.platform === "linux" && process.env.CI) {
    await installLinuxDeps();
  }
  await installTrunk();
}

async function installWasmOpt() {
  // Install wasm-opt from binaryen for additional WASM optimization
  // This Binaryen release includes the -Oz optimization flag.
  const version = BINARYEN_VERSION;
  let platform: string = process.platform;
  if (platform === "darwin") {
    platform = "macos";
  } else if (platform === "win32") {
    platform = "windows";
  }
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const tarName = `binaryen-${version}-${arch}-${platform}.tar.gz`;
  const url = `https://github.com/WebAssembly/binaryen/releases/download/${version}/${tarName}`;
  
  await $`curl -L ${url} -o /tmp/binaryen.tar.gz`;
  await $`tar -xzf /tmp/binaryen.tar.gz -C /tmp`;
  
  // Copy to /usr/local/bin only if we have permissions, otherwise use user directory
  const binDir = process.env.CI ? "/usr/local/bin" : `${process.env.HOME}/.local/bin`;
  if (!process.env.CI) {
    await $`mkdir -p ${binDir}`;
  } else {
    await $`sudo cp /tmp/binaryen-${version}/bin/wasm-opt /usr/local/bin/`;
  }
  if (!process.env.CI) {
    await $`cp /tmp/binaryen-${version}/bin/wasm-opt ${binDir}/`;
  }
  
  await $`rm -rf /tmp/binaryen.tar.gz /tmp/binaryen-${version}`;
}

async function buildWasm() {
  // Trunk 0.21 treats NO_COLOR as a boolean value rather than the usual
  // presence-only convention, so normalize common values such as `1`.
  if (process.env.NO_COLOR && !["true", "false"].includes(process.env.NO_COLOR)) {
    process.env.NO_COLOR = "true";
  }

  // We use trunk to build the project
  await $`trunk build web/index.html --release`;
  
  // Apply additional wasm-opt optimization for size reduction
  const wasmFiles = await $`find dist -name "*.wasm"`.text();
  const files = wasmFiles.split("\n").filter(f => f.trim().length > 0);
  for (const file of files) {
    console.log(`Optimizing ${file} with wasm-opt...`);
    await $`wasm-opt -Oz ${file} -o ${file} --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int`;
  }
}

async function buildRelease() {
  await $`cargo b --release`;
}

async function buildNative(target: string) {
    // Ensure target is added
    await $`rustup target add ${target}`;

    // Set env vars specific to targets
    if (target.includes("apple")) {
        if (target.includes("x86_64")) {
             process.env.CFLAGS = "-fno-stack-check";
             process.env.MACOSX_DEPLOYMENT_TARGET = "10.9";
        } else if (target.includes("aarch64")) {
             process.env.MACOSX_DEPLOYMENT_TARGET = "11";
        }
    }

    await $`cargo build --release --target ${target}`;
}

async function packageLinux(target: string, binary: string, version: string) {
    await $`rm -rf linux`;
    await $`mkdir -p linux`;
    await $`cp target/${target}/release/${binary} linux/`;
    if ((await $`test -d assets`.nothrow()).exitCode === 0) {
        await $`cp -r assets linux/`;
    }

    // Zip naming convention: binary-linux-version.zip
    // The CI currently names it ${binary}.zip inside the artifact, and renames it for release.
    // We will create the properly named file.
    const zipName = `${binary}-linux-${version}.zip`;
    // zip -r relative path
    await $`cd linux && zip -r ../${zipName} .`;
    console.log(`Created ${zipName}`);
}

async function packageWindows(target: string, binary: string, version: string) {
    await $`rm -rf windows`;
    await $`mkdir -p windows`;
    await $`cp target/${target}/release/${binary}.exe windows/`;

    // Check if assets directory exists before copying
    if ((await $`test -d assets`.nothrow()).exitCode === 0) {
        await $`cp -r assets windows/`;
    }

    const zipName = `${binary}-windows-${version}.zip`;
    // Using PowerShell to zip because zip might not be available on Windows environment,
    // and Bun shell doesn't have a built-in zip command (it delegates to system).
    await $`powershell -Command "Compress-Archive -Path windows/* -DestinationPath ${zipName} -Force"`;
    console.log(`Created ${zipName}`);
}

async function packageMac(target: string, binary: string, version: string) {
    const arch = target.includes("aarch64") ? "apple-silicon" : "intel";
    const appName = `${binary}.app`;

    await $`mkdir -p ${appName}/Contents/MacOS`;
    await $`cp target/${target}/release/${binary} ${appName}/Contents/MacOS/`;

    if ((await $`test -d assets`.nothrow()).exitCode === 0) {
        await $`cp -r assets ${appName}/Contents/MacOS/`;
    }

    const dmgName = `${binary}-macOS-${arch}-${version}.dmg`;
    await $`rm -f ${dmgName}`;
    await $`hdiutil create -fs HFS+ -volname "${binary}-${arch}" -srcfolder ${appName} ${dmgName}`;
    console.log(`Created ${dmgName}`);
}

async function packageNative(target: string, binary: string, version?: string) {
    if (!version) {
        version = (await $`git rev-parse --short HEAD`.text()).trim();
    }

    if (target.includes("linux")) {
        await packageLinux(target, binary, version);
    } else if (target.includes("windows")) {
        await packageWindows(target, binary, version);
    } else if (target.includes("apple") || target.includes("darwin")) {
        await packageMac(target, binary, version);
    } else {
        throw new Error(`Unsupported target for packaging: ${target}`);
    }
}

async function checkShouldRelease() {
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (eventName !== "schedule") {
        console.log("true");
        return;
    }

    try {
        const now = new Date();
        const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const yesterdayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
        const since = yesterdayUtc.toISOString();
        const until = todayUtc.toISOString();

        const yesterdayCommits = (await $`git log --since=${since} --until=${until} --pretty=%H -n 1`.text()).trim();
        if (!yesterdayCommits) {
            console.log("false");
            return;
        }
    } catch (error) {
        console.error("Error checking commit history for yesterday:", error);
        console.log("false");
        return;
    }

    try {
        const result = await $`gh release list --limit 1 --json targetCommitish`.text();
        const releases = JSON.parse(result);

        if (releases.length === 0) {
            console.log("true");
            return;
        }

        const lastReleaseCommit = releases[0].targetCommitish;
        const currentCommit = (await $`git rev-parse HEAD`.text()).trim();

        if (lastReleaseCommit === currentCommit) {
            console.log("false");
        } else {
            console.log("true");
        }
    } catch (error) {
        console.error("Error checking release status:", error);
        console.log("true");
    }
}

async function getVersion() {
    const ref = process.env.GITHUB_REF || "";
    const eventName = process.env.GITHUB_EVENT_NAME;

    if (ref.startsWith("refs/tags/")) {
        console.log(ref.replace("refs/tags/", ""));
        return;
    }

    if (eventName === "schedule") {
        const date = new Date().toISOString().split("T")[0];
        console.log(`nightly-${date}`);
        return;
    }

    const sha = (await $`git rev-parse --short HEAD`.text()).trim();
    console.log(`dev-${sha}`);
}

async function test() {
    await $`cargo test --workspace`;
}

async function clippy() {
    await $`cargo clippy --workspace --all-targets --all-features -- -D warnings`;
}

async function fmt() {
    await $`cargo fmt --all -- --check`;
}

const cli = cac("just");

cli
  .option("--env <level>", "Environment to build", {
    default: "linux",
  })
  .command("", "Script for the dinosaur game")
  .action(async (options) => {
    if (options.env && !VALID_ENVS.includes(options.env)) {
        console.error(`Invalid env: ${options.env}. Must be one of: ${VALID_ENVS.join(", ")}`);
        process.exit(1);
    }
    await buildRelease();
  });

cli.command("install-linux-deps", "Install dependencies")
  .action(async () => {
    await installLinuxDeps();
  });

cli.command("install-wasm-deps", "Install wasm dependencies")
  .action(async () => {
    await installWasmDeps();
  });

cli.command("install-wasm-opt", "Install wasm-opt from binaryen")
  .action(async () => {
    await installWasmOpt();
  });

cli.command("build-wasm", "Build wasm")
  .action(async () => {
    await buildWasm();
  });

cli.command("web", "Web build")
  .action(async () => {
    await installWasmDeps();
    await buildWasm();
  });

cli.command("check-should-release", "Check if a release is needed")
    .action(async () => {
        await checkShouldRelease();
    });

cli.command("get-version", "Get the version string")
    .action(async () => {
        await getVersion();
    });

cli.command("test", "Run tests")
    .action(async () => {
        await test();
    });

cli.command("clippy", "Run clippy")
    .action(async () => {
        await clippy();
    });

cli.command("fmt", "Run fmt")
    .action(async () => {
        await fmt();
    });

cli.command("build-native <target>", "Build native binary for target")
    .action(async (target) => {
        await buildNative(target);
    });

cli.command("package-native <target>", "Package native binary for target")
    .option("--app-version <version>", "Version string")
    .action(async (target, options) => {
        await packageNative(target, DEFAULT_BINARY, options.appVersion);
    });

cli.help();
cli.version("0.1.0");

cli.parse();
