import fsp from "node:fs/promises";
import { activeVaultDir } from "@/lib/repos";
import { resolveInVault } from "./paths";
import { requestSync } from "@/lib/git";
import { currentActor } from "@/lib/actor";

/** Lives at the vault root, alongside the notes — travels with the vault via git-sync like
 *  everything else, rather than as host-local app state that wouldn't follow a re-clone. */
const COLORS_FILE = ".engram-colors.json";

function colorsFileAbs(): string {
  return resolveInVault(activeVaultDir(), COLORS_FILE);
}

export async function getFolderColorOverrides(): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(colorsFileAbs(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function setFolderColor(folder: string, color: string): Promise<void> {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("color must be a #rrggbb hex string");
  const current = await getFolderColorOverrides();
  current[folder] = color;
  await fsp.writeFile(colorsFileAbs(), `${JSON.stringify(current, null, 2)}\n`, "utf8");
  requestSync(`${currentActor()}: set color for ${folder}`);
}
