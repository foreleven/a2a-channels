/**
 * Ambient type declarations for third-party packages that ship without
 * TypeScript definitions.
 */

declare module "@openclaw/weixin" {
  const plugin: { register(api: unknown): void };
  export default plugin;
}
