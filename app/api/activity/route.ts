import { vaultActivity } from "@/lib/git";

export const dynamic = "force-dynamic";

/**
 * Recent vault commits (agent + human activity). `?limit=` caps the count (default 50, max 200).
 * `?path=` scopes it to commits touching that vault-relative folder (the folder-browser view).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 200);
  const path = searchParams.get("path") || undefined;
  return Response.json({ activity: await vaultActivity(limit, path) });
}
