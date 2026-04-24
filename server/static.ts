import express, { type Express, type Response } from "express";
import fs from "fs";
import path from "path";
import { getAppVersion } from "./version";

function injectVersionMeta(html: string): string {
  const versionMeta = `<meta name="app-version" content="${getAppVersion()}" />`;
  if (html.includes('name="app-version"')) return html;
  return html.replace(`</head>`, `    ${versionMeta}\n  </head>`);
}

function sendIndexHtml(res: Response, distPath: string) {
  const filePath = path.resolve(distPath, "index.html");
  let html = fs.readFileSync(filePath, "utf-8");
  html = injectVersionMeta(html);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(200).send(html);
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Intercept index.html before express.static so we can inject the
  // <meta name="app-version"> tag and apply no-cache headers.
  app.get(["/", "/index.html"], (_req, res) => {
    sendIndexHtml(res, distPath);
  });

  // Vite-hashed assets (/assets/*) can be cached indefinitely — their
  // filenames change whenever the content changes.
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      maxAge: "1y",
      immutable: true,
    }),
  );

  // All other static files served with no-cache so browsers always
  // re-validate. This is the critical fix: index.html must never be
  // served from cache, otherwise a stale index.html will request JS
  // bundles that no longer exist after a new deployment. Also force
  // no-cache for manifest.json and favicon* so PWA metadata/icon updates
  // propagate deterministically after a deploy.
  app.use(
    express.static(distPath, {
      index: false,
      setHeaders(res, filePath) {
        const base = filePath.split(/[\\/]/).pop() || "";
        const isShellFile =
          base === "index.html" ||
          base === "manifest.json" ||
          base === "sw.js" ||
          /^favicon\.[a-z0-9]+$/i.test(base) ||
          /^apple-touch-icon(-\d+x\d+)?\.png$/i.test(base);
        if (isShellFile) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        }
      },
    }),
  );

  // SPA fallback: serve index.html for all non-asset routes.
  // Asset paths that reach here are genuinely missing — return 404 so the
  // browser does not silently parse HTML as JavaScript (which causes the
  // white screen / ";" symptom after deployments).
  app.use("/{*path}", (req, res) => {
    if (req.path.startsWith("/assets/")) {
      res.status(404).send("Not found");
      return;
    }
    sendIndexHtml(res, distPath);
  });
}
