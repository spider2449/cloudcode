import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./providers.js";

const FILE_NAME = "desktop-recent-projects.json";
const MAX_RECENT_PROJECTS = 20;

export function loadRecentProjects(filePath: string = join(configDir(), FILE_NAME)): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  } catch {
    // Missing or malformed state starts with no restored workspaces.
  }
  return [];
}

export function saveRecentProject(path: string, filePath: string = join(configDir(), FILE_NAME)): void {
  const recent = [path, ...loadRecentProjects(filePath).filter(item => item !== path)].slice(0, MAX_RECENT_PROJECTS);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(recent, null, 2));
}
