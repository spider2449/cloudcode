import { existsSync } from "node:fs";

if (!existsSync("dist") || !existsSync("desktop/dist")) {
  console.error("Missing build output. Run npm run desktop:dist first (tsc + vite).");
  process.exit(1);
}
console.log("desktop-package stub: full orchestration lands in Task 3.");
