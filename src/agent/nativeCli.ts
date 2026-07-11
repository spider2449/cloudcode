// In single-file binary builds the Claude Code native CLI cannot be found via
// the SDK's node_modules lookup, so the entry point extracts an embedded copy
// and registers its path here. Empty in dev, where SDK auto-discovery works.
let nativeCliPath: string | undefined;

export function setNativeCliPath(path: string): void {
  nativeCliPath = path;
}

export function getNativeCliPath(): string | undefined {
  return nativeCliPath;
}
