// Bun-only entrypoint for single-file executable builds.
// Embeds welcome.txt into the binary, then hands off to the normal CLI.
// Not compiled by tsc (outside tsconfig include) because of the import attribute.
import welcomeText from "../welcome.txt" with { type: "text" };
import { setEmbeddedWelcome } from "../src/ui/welcome.js";

setEmbeddedWelcome(welcomeText);
await import("../src/cli.js");
