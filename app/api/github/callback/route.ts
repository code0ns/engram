import { connectGithub, exchangeGithubCode } from "@/lib/github";

export const dynamic = "force-dynamic";

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const redirect = (p: string) => new Response(null, { status: 302, headers: { location: p } });

// GitHub is used ONLY to connect vault repos (an admin task). Dashboard login is Google.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req.headers.get("cookie") || "");
  if (!code || !state || cookies.gh_state !== state) return redirect("/access?tab=workspaces&error=state");

  const token = await exchangeGithubCode(code);
  if (!token) return redirect("/access?tab=workspaces&error=github");
  await connectGithub(token);

  const fallback = "/access?tab=workspaces";
  const next = cookies.gh_next ? decodeURIComponent(cookies.gh_next) : fallback;
  // A same-site path only: "//host" would be a protocol-relative redirect off-site.
  return redirect(next.startsWith("/") && !next.startsWith("//") ? next : fallback);
}
