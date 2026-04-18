import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const candidateSites = ["dist/client", "dist"];

async function hasHtmlFiles(rootDir) {
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
        return true;
      }
    }
  }

  return false;
}

async function selectPagefindSite() {
  for (const dir of candidateSites) {
    if (!existsSync(dir)) continue;
    if (await hasHtmlFiles(dir)) {
      return dir;
    }
  }

  return null;
}

const siteDir = await selectPagefindSite();

if (!siteDir) {
  console.warn(
    "[postbuild] Skipping Pagefind: no .html files found in dist output. This is expected for Astro server output without prerendered pages."
  );
  process.exit(0);
}

console.log(`[postbuild] Running Pagefind on ${siteDir}`);

const child = spawn("pagefind", ["--site", siteDir], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("[postbuild] Failed to run Pagefind:", error);
  process.exit(1);
});