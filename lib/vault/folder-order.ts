import fsp from "node:fs/promises";
import { resolveInVault } from "./paths";
import { requestSync } from "@/lib/git";
import { currentActor } from "@/lib/actor";

/**
 * Stores custom folder ordering. Lives at the vault root alongside the notes — travels with
 * the vault via git-sync like everything else (same pattern as .engram-colors.json).
 * 
 * Structure: { [parentPath: string]: string[] }
 * - parentPath is "" for root-level folders, or "folder/subfolder" for nested
 * - The array contains folder names (not full paths) in the desired order
 * - Folders not in the array appear after ordered ones, sorted alphabetically
 */
const ORDER_FILE = ".engram-folder-order.json";

function orderFileAbs(dir: string): string {
  return resolveInVault(dir, ORDER_FILE);
}

export type FolderOrder = Record<string, string[]>;

export async function getFolderOrder(dir: string): Promise<FolderOrder> {
  try {
    const raw = await fsp.readFile(orderFileAbs(dir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Set the order of folders within a parent directory.
 * @param dir - The vault directory
 * @param parentPath - Parent folder path ("" for root level)
 * @param folderNames - Array of folder names in desired order
 */
export async function setFolderOrder(
  dir: string,
  parentPath: string,
  folderNames: string[],
): Promise<void> {
  const current = await getFolderOrder(dir);
  if (folderNames.length === 0) {
    delete current[parentPath];
  } else {
    current[parentPath] = folderNames;
  }
  await fsp.writeFile(orderFileAbs(dir), `${JSON.stringify(current, null, 2)}\n`, "utf8");
  requestSync(dir, `${currentActor()}: reorder folders in ${parentPath || "root"}`);
}

/**
 * Sort folder names according to the custom order for a parent path.
 * Items in the order array come first (in that order), followed by
 * remaining items sorted alphabetically.
 */
export function applyFolderOrder(
  folderNames: string[],
  order: string[] | undefined,
): string[] {
  if (!order || order.length === 0) {
    return [...folderNames].sort((a, b) => a.localeCompare(b));
  }
  
  const orderSet = new Set(order);
  const ordered: string[] = [];
  const unordered: string[] = [];
  
  for (const name of folderNames) {
    if (orderSet.has(name)) {
      ordered.push(name);
    } else {
      unordered.push(name);
    }
  }
  
  ordered.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  unordered.sort((a, b) => a.localeCompare(b));
  
  return [...ordered, ...unordered];
}
