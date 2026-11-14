/** UUID con la Web Crypto API (disponible igual en Node y en Cloudflare Workers). */
export const randomUUID = (): string => crypto.randomUUID();
