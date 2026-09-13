import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/desktop/renderer",
  plugins: [react()],
  base: "./",
  build: { outDir: "../../../dist/renderer", emptyOutDir: true }
});
