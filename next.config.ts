import type { NextConfig } from "next";

const config: NextConfig = {
  // Syscalls touch the filesystem, child processes and provider SDKs — they
  // must never be bundled into the edge runtime.
  serverExternalPackages: ["@anthropic-ai/sdk"],
  experimental: {
    // The kernel streams for minutes at a time on long agentic runs.
    proxyTimeout: 1000 * 60 * 30,
  },
};

export default config;
