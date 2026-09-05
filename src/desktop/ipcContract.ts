export function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function requireOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

export function requireDimension(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000) throw new Error(`Invalid ${label}.`);
  return value;
}

export function requirePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) throw new Error("Invalid Git paths.");
  return value.map((path, index) => requireString(path, `Git path ${index + 1}`));
}

export function requireBranchName(value: unknown): string {
  const branch = requireString(value, "branch name").trim();
  if (branch.startsWith("-") || /[\0\r\n]/.test(branch)) throw new Error("Invalid branch name.");
  return branch;
}
