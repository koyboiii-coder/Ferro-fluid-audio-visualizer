import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so dist/index.html also works when Electron opens
  // it straight off disk via file:// (absolute "/assets/..." paths only
  // resolve correctly when served over http).
  base: "./",
});
