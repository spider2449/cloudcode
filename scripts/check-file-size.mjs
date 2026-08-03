#!/usr/bin/env node
// Mechanizes the module-size ceiling AGENTS.md sets: a file over SOFT_LIMIT
// lines needs a deliberate decision to split, and one over HARD_LIMIT has to
// actually be split. Soft breaches are reported (as GitHub Actions warning
// annotations when running in CI) but do not fail; hard breaches fail.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SOFT_LIMIT = 600;
const HARD_LIMIT = 1000;
const ROOTS = ["src", "tests"];
const EXTENSIONS = [".ts", ".tsx", ".mjs"];
const inActions = process.env.GITHUB_ACTIONS === "true";

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (EXTENSIONS.some(ext => entry.name.endsWith(ext))) files.push(path);
  }
  return files;
}

const offenders = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > SOFT_LIMIT) offenders.push({ file: file.replace(/\\/g, "/"), lines });
  }
}
offenders.sort((a, b) => b.lines - a.lines);

const hard = offenders.filter(o => o.lines > HARD_LIMIT);
for (const { file, lines } of offenders) {
  const overHard = lines > HARD_LIMIT;
  const limit = overHard ? HARD_LIMIT : SOFT_LIMIT;
  const message = `${file} is ${lines} lines, over the ${limit}-line ${overHard ? "hard" : "soft"} limit (see AGENTS.md)`;
  if (inActions) console.log(`::${overHard ? "error" : "warning"} file=${file}::${message}`);
  else console.log(`${overHard ? "FAIL" : "warn"}  ${message}`);
}

if (hard.length > 0) {
  console.error(`\n${hard.length} file(s) over the ${HARD_LIMIT}-line hard limit. Split them before merging.`);
  process.exit(1);
}
if (offenders.length === 0) console.log(`All files under ${SOFT_LIMIT} lines.`);
