// Shared runtime for single-file executable entries (Bun-only).
export async function startFromBinary(welcomeText: string): Promise<void> {
  const { setEmbeddedWelcome } = await import("../src/ui/welcome.js");
  setEmbeddedWelcome(welcomeText);
  await import("../src/cli.js");
}
