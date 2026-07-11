export type NormalizedRepo =
  | { ok: true; url: string; dirName: string }
  | { ok: false; error: string };

const GITHUB_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/;

export function normalizeRepoUrl(input: string): NormalizedRepo {
  const trimmed = input.trim();
  const match = GITHUB_URL.exec(trimmed) ?? SHORTHAND.exec(trimmed);
  if (!match) {
    return { ok: false, error: `Unsupported repo: "${input}". Use https://github.com/owner/repo or owner/repo.` };
  }
  const [, owner, repo] = match;
  return {
    ok: true,
    url: `https://github.com/${owner}/${repo}.git`,
    dirName: `${owner}--${repo}`
  };
}
