export interface ServerConfig {
  extensions: string[];
  command: string;
  args: string[];
  rootMarkers: string[];
  enabled?: boolean;
}

export const DEFAULT_SERVERS: Record<string, ServerConfig> = {
  typescript: {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "package.json", ".git"]
  },
  python: {
    extensions: [".py", ".pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
    rootMarkers: ["pyproject.toml", "setup.py", ".git"]
  },
  rust: {
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    rootMarkers: ["Cargo.toml", ".git"]
  },
  go: {
    extensions: [".go"],
    command: "gopls",
    args: [],
    rootMarkers: ["go.mod", ".git"]
  }
};
