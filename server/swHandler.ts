import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getAppVersion } from "./version";

let cachedSwSource: string | null = null;

function loadSwSource(): string {
  if (cachedSwSource) return cachedSwSource;

  const candidates = [
    path.resolve(import.meta.dirname, "..", "client", "public", "sw.js"),
    path.resolve(import.meta.dirname, "public", "sw.js"),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedSwSource = fs.readFileSync(candidate, "utf-8");
        return cachedSwSource;
      }
    } catch {}
  }

  throw new Error(`sw.js not found in any of: ${candidates.join(", ")}`);
}

export function registerSwHandler(app: Express) {
  app.get("/sw.js", (_req: Request, res: Response) => {
    try {
      const src = loadSwSource();
      const body = src.replace(/__APP_VERSION__/g, getAppVersion());
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Service-Worker-Allowed", "/");
      res.status(200).send(body);
    } catch (err: any) {
      res.status(500).send(`// sw.js load error: ${err.message}`);
    }
  });
}
