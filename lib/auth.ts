import { SignJWT, jwtVerify } from "jose";
import { ALLOWED_EMAILS, APP_URL, AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_COOKIE } from "@/lib/config";

const key = () => new TextEncoder().encode(AUTH_SECRET);

export interface Session {
  email: string;
  name?: string;
  /**
   * The dashboard user's current workspace — a HINT only, set when they switch (see
   * app/api/repos/active/route.ts). Every route that uses it must re-validate against
   * live grants (lib/access.ts) via lib/workspace-resolve.ts; a stale/revoked value here
   * must never be trusted as authorization by itself. Absent on cookies minted before
   * workspace permissions existed — fully backward compatible.
   */
  workspaceId?: string;
}

export async function createSessionToken(session: Session): Promise<string> {
  return new SignJWT({ email: session.email, name: session.name, workspaceId: session.workspaceId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    return {
      email: payload.email as string,
      name: payload.name as string | undefined,
      workspaceId: payload.workspaceId as string | undefined,
    };
  } catch {
    return null;
  }
}

/** Decode + verify the session cookie off a Request. Consolidates the ad-hoc cookie
 *  parsing that used to be duplicated in middleware.ts and notes/[...path]/route.ts. */
export async function getSession(req: Request): Promise<Session | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const raw = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  return verifySessionToken(raw.slice(SESSION_COOKIE.length + 1));
}

/** An email is allowed only if it's on the allowlist. Empty allowlist => nobody. */
export function isAllowed(email: string): boolean {
  return ALLOWED_EMAILS.length > 0 && ALLOWED_EMAILS.includes(email.toLowerCase());
}

const REDIRECT_URI = () => `${APP_URL}/api/auth/callback`;

export function googleAuthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI(),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function exchangeCodeForUser(code: string): Promise<Session | null> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return null;
  const { access_token } = await tokenRes.json();
  const uiRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!uiRes.ok) return null;
  const ui = await uiRes.json();
  if (!ui.email) return null;
  return { email: ui.email as string, name: ui.name as string | undefined };
}
