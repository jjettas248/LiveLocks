import { execSync } from "child_process";

let cachedVersion: string | null = null;

function deriveVersion(): string {
  const envVersion = process.env.APP_VERSION?.trim();
  if (envVersion) return envVersion;

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
