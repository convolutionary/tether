import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// a slow 1×1 image holds the page's load event, so headless screenshots wait for the scene
const delay = {
  name: "delay",
  configureServer(server: { middlewares: { use: (f: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__delay")) return next();
      const ms = Number(new URL(req.url, "http://x").searchParams.get("ms") ?? 2500);
      setTimeout(() => {
        res.setHeader("content-type", "image/gif");
        res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
      }, ms);
    });
  },
};

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), delay],
  server: { port: 1421, strictPort: true, fs: { allow: [resolve(__dirname, "..")] } },
});
