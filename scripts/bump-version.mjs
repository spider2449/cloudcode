import { readFileSync, writeFileSync } from "node:fs";

// Bumps the patch version everywhere AGENTS.md requires it to agree:
// package.json, package-lock.json (both occurrences), src/version.ts,
// installer/cloudcode.iss. tests/packaging.test.ts enforces the agreement.

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
if ([major, minor, patch].some(n => !Number.isInteger(n))) {
  throw new Error(`Unparseable version in package.json: ${pkg.version}`);
}
const next = `${major}.${minor}.${patch + 1}`;

function replaceFirst(text, from, to) {
  const updated = text.replace(from, () => to);
  if (updated === text) throw new Error(`Pattern not found: ${from}`);
  return updated;
}

const pkgText = replaceFirst(
  readFileSync("package.json", "utf8"),
  `"version": "${pkg.version}"`,
  `"version": "${next}"`
);
writeFileSync("package.json", pkgText);

let lockText = readFileSync("package-lock.json", "utf8");
for (let i = 0; i < 2; i++) {
  lockText = replaceFirst(lockText, `"version": "${pkg.version}"`, `"version": "${next}"`);
}
writeFileSync("package-lock.json", lockText);

writeFileSync(
  "src/version.ts",
  replaceFirst(readFileSync("src/version.ts", "utf8"), `VERSION = "${pkg.version}"`, `VERSION = "${next}"`)
);
writeFileSync(
  "installer/cloudcode.iss",
  replaceFirst(
    readFileSync("installer/cloudcode.iss", "utf8"),
    `#define AppVersion "${pkg.version}"`,
    `#define AppVersion "${next}"`
  )
);
console.log(`${pkg.version} -> ${next}`);
