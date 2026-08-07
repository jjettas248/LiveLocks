import { execSync } from "child_process";

declare const __BUILD_COMMIT_SHA__: string | undefined;

let cachedVersion: string | null = null;

function deriveVersion(): string {
  const envVersion = process.env.APP_VERSION?.trim();
  if (envVersion) return envVersion;

  if (typeof __BUILD_COMMIT_SHA__ !== "undefined" && __BUILD_COMMIT_SHA__) {
    return __BUILD_COMMIT_SHA__;
  }

  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {}

  return `ts-${Date.now()}`;
}

export function getAppVersion(): string {
  if (!cachedVersion) {
    cachedVersion = deriveVersion();
  }
  return cachedVersion;
}
