import { getFolderColorOverrides, setFolderColor } from "@/lib/vault/colors";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ colors: await getFolderColorOverrides() });
}

export async function PATCH(req: Request) {
  const { folder, color } = await req.json().catch(() => ({}));
  if (!folder || typeof folder !== "string") return Response.json({ error: "folder required" }, { status: 400 });
  if (!color || typeof color !== "string") return Response.json({ error: "color required" }, { status: 400 });
  try {
    await setFolderColor(folder, color);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "invalid color" }, { status: 400 });
  }
  return Response.json({ ok: true });
}
