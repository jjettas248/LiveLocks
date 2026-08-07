import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
import { execSync } from "child_process";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

function getBuildCommitSha(): { sha: string | null; source: string } {
  // Railway's Railpack build container has no git binary, so prefer the
  // platform-provided commit env var; fall back to git for local/other builds.
  const envSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (envSha) {
    return { sha: envSha.slice(0, 7), source: "RAILWAY_GIT_COMMIT_SHA env" };
  }

  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (sha) return { sha, source: "git rev-parse" };
  } catch {}

  return { sha: null, source: "unavailable" };
}

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  // Captured here because the runtime container has neither git nor
  // RAILWAY_GIT_COMMIT_SHA — this is the only point where either is available.
  const { sha: buildCommitSha, source: buildCommitShaSource } =
    getBuildCommitSha();
  console.log(
    buildCommitSha
      ? `captured build commit sha via ${buildCommitShaSource}: ${buildCommitSha}`
      : `could not capture build commit sha (${buildCommitShaSource})`,
  );

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
      __BUILD_COMMIT_SHA__: buildCommitSha
        ? JSON.stringify(buildCommitSha)
        : "undefined",
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
