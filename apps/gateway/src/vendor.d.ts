/**
 * Ambient type declarations for third-party packages that ship without
 * TypeScript definitions.
 */

declare module "@openclaw/weixin" {
  const plugin: { register(api: unknown): void };
  export default plugin;
}

declare module "@openclaw/weixin/src/api/api.js" {
  export function apiGetFetch(params: {
    baseUrl: string;
    endpoint: string;
    timeoutMs?: number;
    label: string;
  }): Promise<string>;

  export function apiPostFetch(params: {
    baseUrl: string;
    endpoint: string;
    body: string;
    token?: string;
    timeoutMs?: number;
    label: string;
  }): Promise<string>;
}

declare module "qrcode" {
  const QRCode: {
    toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
  };
  export default QRCode;
}
