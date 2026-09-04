import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const distOnly = args.includes("--dist-only");
const target = args.find((a) => ["--win", "--linux", "--mac"].includes(a));

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", shell: true });
}

run("npx tsc -p tsconfig.json");
run("npx vite build --config desktop/vite.config.ts");

if (!existsSync("dist/cli.js")) {
  console.error("Missing dist/cli.js after build. Aborting desktop package.");
  process.exit(1);
}
if (!existsSync("desktop/dist/index.html")) {
  console.error("Missing desktop/dist/index.html after vite build. Aborting desktop package.");
  process.exit(1);
}
if (distOnly) process.exit(0);

run("npx electron-builder install-app-deps");
run(`npx electron-builder ${target ?? ""}`.trim());
