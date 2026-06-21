import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // When embedded in Tauri the webview loads from the file system,
  // so assets must use relative paths.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,   // Tauri convention; also used for standalone dev
    strictPort: true,
  },
});
