import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await Promise.all([
  copyFile(join(root, "manifest.json"), join(outdir, "manifest.json")),
  copyFile(join(root, "options.html"), join(outdir, "options.html"))
]);

await esbuild.build({
  entryPoints: [
    join(root, "src", "background.ts"),
    join(root, "src", "content.ts"),
    join(root, "src", "options.ts")
  ],
  bundle: true,
  outbase: join(root, "src"),
  outdir,
  format: "iife",
  target: "chrome124",
  sourcemap: false,
  logLevel: "info"
});
