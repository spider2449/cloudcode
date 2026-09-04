import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "desktop/renderer",
  plugins: [react()],
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true }
});
