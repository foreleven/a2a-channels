/**
 * Ambient type declarations for third-party packages that ship without
 * TypeScript definitions.
 */

declare module "@larksuite/openclaw-lark" {
  const plugin: { register(api: unknown): void };
  const exports = { default: plugin };
  export default exports;
}
