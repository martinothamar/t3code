/** Vite's proxy and the server's dev 404 handler must share prefixes to avoid index.html responses or redirect loops. */
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/mcp",
  // agentctl Sandboxes the server relays, with their own sockets.
  "/sandbox",
] as const;

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
