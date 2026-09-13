import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The T3N SDK loads a `.wasm` component from its own package directory at
   * runtime. Bundling it rewrites that path and the load fails; the docs flag
   * this as a known rough edge and recommend keeping WASM work out of the
   * bundler entirely. `serverExternalPackages` does exactly that while keeping
   * every SDK call on the Node runtime, where it is known to work.
   */
  serverExternalPackages: ["@terminal3/t3n-sdk"],

  // Nothing in this app may reach the browser holding a credential, and the
  // SDK must never end up in a client bundle.
  poweredByHeader: false,
};

export default nextConfig;
