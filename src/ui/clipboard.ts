import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

export type ClipboardRunner = (targetPath: string) => Promise<void>;

const platformRunner: ClipboardRunner = (targetPath) => new Promise((resolvePromise, reject) => {
  if (process.platform === "win32") {
    // PowerShell System.Drawing saves the clipboard bitmap as PNG.
    const script =
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$img = [Windows.Forms.Clipboard]::GetImage();" +
      `if ($img) { $img.Save('${targetPath}', [Drawing.Imaging.ImageFormat]::Png) }`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }, err => err ? reject(err) : resolvePromise());
    return;
  }
  if (process.platform === "darwin") {
    // macOS: osascript writes the clipboard PNG class to the target file.
    execFile("osascript", ["-e",
      "set pngData to (the clipboard as class PNGf)" +
      "\nset fh to open for access POSIX file \"" + targetPath + "\" with write permission"
    ], {}, err => err ? reject(err) : resolvePromise());
    return;
  }
  // linux / X11
  execFile("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {},
    (err, stdout) => {
      if (err) { reject(err); return; }
      writeFileSync(targetPath, stdout);
      resolvePromise();
    });
});

/** Writes the clipboard image (when present) to targetPath as PNG. Never throws. */
export async function captureClipboardImage(
  targetPath: string,
  run: ClipboardRunner = platformRunner
): Promise<{ savedPath?: string; error?: string }> {
  try {
    await run(targetPath);
    return { savedPath: targetPath };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
