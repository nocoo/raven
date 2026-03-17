import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isAuthEnabled } from "@/lib/auth-mode";

// ---------------------------------------------------------------------------
// Local mode — no authentication required
// ---------------------------------------------------------------------------

if (!isAuthEnabled) {
  console.info(
    "[auth] Local mode — authentication disabled. " +
      "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and NEXTAUTH_SECRET to enable.",
  );
}

// ---------------------------------------------------------------------------
// Local mode stubs
// ---------------------------------------------------------------------------

// localAuth: compatible with NextAuth middleware wrapper signature.
// Accepts a handler function, returns a function that calls it with
// the original request object + auth: null.
function localAuth(handler: (req: any) => any) {
  return (req: any) => handler(Object.assign(Object.create(req), { auth: null }));
}

// Session endpoint: NextAuth's fetchData() returns res.json() directly.
// SessionProvider sets status = session ? "authenticated" : "unauthenticated".
// Returning JSON null ensures session is falsy → status = "unauthenticated".
const LOCAL_SESSION_RESPONSE = new Response("null", {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

const localHandlers = {
  GET: () => LOCAL_SESSION_RESPONSE.clone(),
  POST: () => LOCAL_SESSION_RESPONSE.clone(),
};

// ---------------------------------------------------------------------------
// Auth mode — Google OAuth
// ---------------------------------------------------------------------------

function createGoogleAuth() {
  const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.length === 0) {
    console.warn(
      "[auth] ⚠ ALLOWED_EMAILS is not set — all Google accounts can sign in. " +
        "Set ALLOWED_EMAILS=you@example.com to restrict access.",
    );
  }

  // For reverse proxy environments with HTTPS, we need secure cookies
  const useSecureCookies =
    process.env.NODE_ENV === "production" ||
    process.env.NEXTAUTH_URL?.startsWith("https://") ||
    process.env.USE_SECURE_COOKIES === "true";

  return NextAuth({
    trustHost: true,
    providers: [
      Google({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
    ],
    pages: {
      signIn: "/login",
      error: "/login",
    },
    cookies: {
      pkceCodeVerifier: {
        name: useSecureCookies
          ? "__Secure-authjs.pkce.code_verifier"
          : "authjs.pkce.code_verifier",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      state: {
        name: useSecureCookies ? "__Secure-authjs.state" : "authjs.state",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      callbackUrl: {
        name: useSecureCookies
          ? "__Secure-authjs.callback-url"
          : "authjs.callback-url",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      sessionToken: {
        name: useSecureCookies
          ? "__Secure-authjs.session-token"
          : "authjs.session-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      csrfToken: {
        name: useSecureCookies
          ? "__Host-authjs.csrf-token"
          : "authjs.csrf-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
    },
    callbacks: {
      async signIn({ user }) {
        const email = user.email?.toLowerCase();
        if (!email) return false;
        // If no allowlist is configured, permit any authenticated Google account
        if (allowedEmails.length === 0) return true;
        return allowedEmails.includes(email);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Conditional init — always export the same 4 symbols
// ---------------------------------------------------------------------------

const authExports = isAuthEnabled
  ? createGoogleAuth()
  : {
      handlers: localHandlers,
      signIn: async () => "/" as any,
      signOut: async () => "/" as any,
      auth: localAuth as any,
    };

export const { handlers, signIn, signOut, auth } = authExports;
export { isAuthEnabled };
