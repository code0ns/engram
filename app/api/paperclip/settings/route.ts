import { publicPaperclipSettings, updatePaperclipSettings, type PaperclipSettingsPatch } from "@/lib/paperclip/settings";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(publicPaperclipSettings());
}

export async function PUT(req: Request) {
  let body: PaperclipSettingsPatch;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    return Response.json(updatePaperclipSettings(body));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "update failed" }, { status: 500 });
  }
}
