import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

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
  // bundles that no longer exist after a new deployment.
  app.use(
    express.static(distPath, {
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
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
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
