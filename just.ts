#!/usr/bin/env -S deno run -A
import { $ } from "@david/dax";
import { cac } from "cac";
import { homedir } from "node:os";
import { join } from "node:path";

// If you need env types similar to EnumType in cliffy, you can handle validation manually
const VALID_ENVS = ["linux", "windows", "macos"];

interface Env {
  binary: string;
}

const DEFAULT_BINARY = "dinosaur-game";
const TRUNK_VERSION = "0.21.14";

interface TrunkArtifact {
  archive: string;
  sha256: string;
}

// Official Trunk release archives, pinned to avoid resolving its Cargo dependencies.
const TRUNK_ARTIFACTS: Record<string, TrunkArtifact> = {
  "darwin-aarch64": {
    archive: "trunk-aarch64-apple-darwin.tar.gz",
    sha256: "764e299dd50d89442a4e96a236349f57961984b701e74d3dbdb39cd1c9f5101e",
  },
  "darwin-x86_64": {
    archive: "trunk-x86_64-apple-darwin.tar.gz",
    sha256: "f1ba0e3bbe24e0ae219c6d22c33e24e2825c1608dd27c2556e323495110f1a95",
  },
  "linux-aarch64": {
    archive: "trunk-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "b1d8e60e454f7fc182d9a4d95d1506ffbae947d8ba90f8f6f02da93b60f980f9",
  },
  "linux-x86_64": {
    archive: "trunk-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "f2b4680cd239693a646a2795e4633c625328d7b2a044fbe749fa3a2fe9e7036b",
  },
  "windows-x86_64": {
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
  try {
    if ((await $`trunk --version`.text()).trim() === expectedVersion) {
      console.log(`${expectedVersion} is already installed`);
      return;
    }
  } catch {
    // Install the pinned release when Trunk is absent.
  }

  const artifact = TRUNK_ARTIFACTS[`${Deno.build.os}-${Deno.build.arch}`];
  if (!artifact) {
    throw new Error(
      `No pinned Trunk artifact for ${Deno.build.os}-${Deno.build.arch}`,
    );
  }

  const url =
    `https://github.com/trunk-rs/trunk/releases/download/v${TRUNK_VERSION}/${artifact.archive}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", archiveBytes),
  );
  const actualHash = Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actualHash !== artifact.sha256) {
    throw new Error(
      `Checksum mismatch for ${artifact.archive}: expected ${artifact.sha256}, got ${actualHash}`,
    );
  }

  const tempDir = await Deno.makeTempDir({ prefix: "dinosaur-game-trunk-" });
  try {
    const archivePath = join(tempDir, artifact.archive);
    await Deno.writeFile(archivePath, archiveBytes);

    if (Deno.build.os === "windows") {
      await $`powershell -NoProfile -Command Expand-Archive -LiteralPath ${archivePath} -DestinationPath ${tempDir} -Force`;
    } else {
      await $`tar -xzf ${archivePath} -C ${tempDir}`;
    }

    const executableName = Deno.build.os === "windows" ? "trunk.exe" : "trunk";
    const binDir = join(
      Deno.env.get("CARGO_HOME") ?? join(homedir(), ".cargo"),
      "bin",
    );
    const installedPath = join(binDir, executableName);
    await Deno.mkdir(binDir, { recursive: true });
    await Deno.copyFile(join(tempDir, executableName), installedPath);
    if (Deno.build.os !== "windows") await Deno.chmod(installedPath, 0o755);

    const version = (await $`${installedPath} --version`.text()).trim();
    if (version !== expectedVersion) {
      throw new Error(`Installed unexpected Trunk version: ${version}`);
    }
    console.log(`Installed ${version} at ${installedPath}`);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

async function installWasmDeps() {
  if (Deno.build.os === "linux" && Deno.env.get("CI")) {
    await installLinuxDeps();
  }
  await installTrunk();
}

async function buildWasm() {
  // Trunk 0.21 parses NO_COLOR as a boolean rather than following its common "1" form.
  if (Deno.env.get("NO_COLOR") === "1") Deno.env.set("NO_COLOR", "true");
  await $`trunk build web/index.html --release`;
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
      Deno.env.set("CFLAGS", "-fno-stack-check");
      Deno.env.set("MACOSX_DEPLOYMENT_TARGET", "10.9");
    } else if (target.includes("aarch64")) {
      Deno.env.set("MACOSX_DEPLOYMENT_TARGET", "11");
    }
  }

  await $`cargo build --release --target ${target}`;
}

async function packageLinux(target: string, binary: string, version: string) {
  await $`rm -rf linux`;
  await $`mkdir -p linux`;
  await $`cp target/${target}/release/${binary} linux/`;
  if ((await $`test -d assets`.noThrow()).code === 0) {
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
  if ((await $`test -d assets`.noThrow()).code === 0) {
    await $`cp -r assets windows/`;
  }

  const zipName = `${binary}-windows-${version}.zip`;
  // Using PowerShell to zip because zip might not be available on Windows.
  await $`powershell -Command "Compress-Archive -Path windows/* -DestinationPath ${zipName} -Force"`;
  console.log(`Created ${zipName}`);
}

async function packageMac(target: string, binary: string, version: string) {
  const arch = target.includes("aarch64") ? "apple-silicon" : "intel";
  const appName = `${binary}.app`;

  await $`mkdir -p ${appName}/Contents/MacOS`;
  await $`cp target/${target}/release/${binary} ${appName}/Contents/MacOS/`;

  if ((await $`test -d assets`.noThrow()).code === 0) {
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
  const eventName = Deno.env.get("GITHUB_EVENT_NAME");
  if (eventName !== "schedule") {
    console.log("true");
    return;
  }

  try {
    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const yesterdayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    );
    const since = yesterdayUtc.toISOString();
    const until = todayUtc.toISOString();

    const yesterdayCommits =
      (await $`git log --since=${since} --until=${until} --pretty=%H -n 1`
        .text()).trim();
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
    const result = await $`gh release list --limit 1 --json targetCommitish`
      .text();
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
  const ref = Deno.env.get("GITHUB_REF") || "";
  const eventName = Deno.env.get("GITHUB_EVENT_NAME");

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
      console.error(
        `Invalid env: ${options.env}. Must be one of: ${VALID_ENVS.join(", ")}`,
      );
      Deno.exit(1);
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
