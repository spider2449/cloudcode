import fs from "node:fs";
import path from "node:path";

const srcDir = "F:\\coding\\otherPrj\\cloudcode\\src";

function countLines(p) {
  const content = fs.readFileSync(p, "utf8");
  return content.split("\n").length;
}

function walk(dir, files = []) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (f.endsWith(".ts")) files.push(full);
  }
  return files;
}

const results = walk(srcDir).map(f => ({
  file: f.replace(srcDir + "\\", "").replace(/\\/g, "/"),
  lines: countLines(f)
}));

results.sort((a, b) => b.lines - a.lines);
console.log("Top 20 files by line count:");
results.slice(0, 20).forEach(r => console.log(String(r.lines).padStart(5) + "  " + r.file));

const total = results.reduce((sum, r) => sum + r.lines, 0);
console.log("\nTotal TypeScript files: " + results.length);
console.log("Total lines of TypeScript: " + total);
