import welcomeText from "../welcome.txt" with { type: "text" };
import { startFromBinary } from "./bin-runtime.js";
await startFromBinary(welcomeText);
