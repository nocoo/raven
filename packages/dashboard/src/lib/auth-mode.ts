// Server/shared flag — true when all 3 required OAuth vars are present.
// Client components must NOT import this file (it reads secret env vars).
// Use process.env.NEXT_PUBLIC_AUTH_ENABLED (injected via next.config.ts) instead.
export const isAuthEnabled =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.NEXTAUTH_SECRET;
