"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronRight, Folder, FileText, Home, Palette, Pencil, Search, Trash2 } from "lucide-react";
import { fetcher, folderColor, type TreeNode, type NoteMeta } from "@/lib/client";
import { navItemClass } from "@/lib/use-arrow-nav";
import { ActivityList, type ActivityEntry } from "@/components/activity-list";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RenameInput, ColorPicker, dirOf, join, useVaultMutations } from "@/components/tree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Hit {
  path: string;
  title: string;
  folder: string;
  type?: string;
}

const iconBox = "flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground";

/** Walk the tree to the node at `folderPath` (dir segments only). Null if it doesn't exist. */
function findDir(root: TreeNode, folderPath: string): TreeNode | null {
  if (!folderPath) return root;
  let cur = root;
  for (const part of folderPath.split("/")) {
    const next = cur.children?.find((c) => c.type === "dir" && c.name === part);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

const STATUS_STYLE: Record<string, string> = {
  authoritative: "bg-emerald-500/15 text-emerald-500",
  current: "bg-blue-500/15 text-blue-400",
  provisional: "bg-amber-500/15 text-amber-500",
  wip: "bg-amber-500/15 text-amber-500",
  draft: "bg-amber-500/15 text-amber-500",
  exploring: "bg-amber-500/15 text-amber-500",
  idea: "bg-amber-500/15 text-amber-500",
  superseded: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const cls = STATUS_STYLE[status.toLowerCase()] ?? "bg-muted text-muted-foreground";
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{status}</span>;
}

/** A subfolder tile — click navigates a level deeper; right-click reuses the sidebar's own
 *  rename/color/delete menu and the same `/api/folders/[...path]` + `/api/folder-colors` routes. */
function FolderCard({ node, colors }: { node: TreeNode; colors?: Record<string, string> }) {
  const router = useRouter();
  const refresh = useVaultMutations();
  const { mutate } = useSWRConfig();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickingColor, setPickingColor] = useState(false);
  const color = folderColor(node.name, colors);
  const count = node.children?.length ?? 0;

  async function rename(newName: string) {
    setRenaming(false);
    const to = join(dirOf(node.path), newName);
    const res = await fetch(`/api/folders/${node.path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (res.ok) refresh();
  }

  async function doDelete() {
    setConfirmDelete(false);
    const res = await fetch(`/api/folders/${node.path}`, { method: "DELETE" });
    if (res.ok) refresh();
  }

  async function setColor(hex: string) {
    setPickingColor(false);
    const res = await fetch("/api/folder-colors", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: node.name, color: hex }),
    });
    if (res.ok) mutate("/api/folder-colors");
  }

  return (
    <div className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Card
            data-nav-item
            role="button"
            tabIndex={0}
            onClick={() => !renaming && router.push(`/f/${node.path}`)}
            className={`group flex-row items-center gap-3 p-3 transition-colors hover:border-ring ${navItemClass}`}
          >
            <div className={iconBox} style={{ color }}>
              <Folder size={16} />
            </div>
            <div className="min-w-0 flex-1">
              {renaming ? (
                <RenameInput initial={node.name} onSubmit={rename} onCancel={() => setRenaming(false)} />
              ) : (
                <span className="block truncate text-sm font-medium">{node.name}</span>
              )}
              <span className="block truncate text-xs text-muted-foreground">
                {count} item{count === 1 ? "" : "s"}
              </span>
            </div>
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(true)}>
            <Pencil size={13} /> Rename
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setPickingColor(true)}>
            <Palette size={13} /> Color…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> Delete folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {pickingColor && <ColorPicker initial={color} onSave={setColor} onCancel={() => setPickingColor(false)} />}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{node.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes every note inside this folder. This cannot be undone from the dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A note tile — click opens it; right-click reuses the sidebar's own rename/delete menu and the
 *  same `/api/notes/[...path]` route. */
function NoteCard({ node, meta }: { node: TreeNode; meta?: NoteMeta }) {
  const router = useRouter();
  const refresh = useVaultMutations();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const baseName = node.name.replace(/\.md$/i, "");

  async function rename(newName: string) {
    setRenaming(false);
    const to = join(dirOf(node.path), newName.replace(/\.md$/i, "") + ".md");
    const res = await fetch(`/api/notes/${node.path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      refresh();
      router.push(`/n/${d.path}`);
    }
  }

  async function doDelete() {
    setConfirmDelete(false);
    const res = await fetch(`/api/notes/${node.path}`, { method: "DELETE" });
    if (res.ok) refresh();
  }

  return (
    <div className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Card
            data-nav-item
            role="button"
            tabIndex={0}
            onClick={() => !renaming && router.push(`/n/${node.path}`)}
            className={`group flex-row items-center gap-3 p-3 transition-colors hover:border-ring ${navItemClass}`}
          >
            <div className={iconBox}>
              <FileText size={16} />
            </div>
            <div className="min-w-0 flex-1">
              {renaming ? (
                <RenameInput initial={baseName} onSubmit={rename} onCancel={() => setRenaming(false)} />
              ) : (
                <span className="block truncate text-sm font-medium">{node.title || node.name}</span>
              )}
              {meta && (meta.status || meta.tags.length > 0) && (
                <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden">
                  <StatusBadge status={meta.status} />
                  {meta.tags.slice(0, 2).map((t) => (
                    <span key={t} className="shrink-0 truncate text-[10px] text-muted-foreground">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(true)}>
            <Pencil size={13} /> Rename
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{node.title || node.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone from the dashboard.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Google-Drive-style browser for one folder — the same "search / jump in / recent activity"
 * shape as the home page, scoped to `folderPath` instead of the whole vault. Deliberately a
 * separate component (not a home-page edit): the home page keeps its own localStorage-driven
 * "recently viewed" grid, while this one shows the folder's actual immediate children.
 */
export function FolderBrowser({ folderPath }: { folderPath: string }) {
  const router = useRouter();
  const { data: treeData } = useSWR<{ tree: TreeNode }>("/api/tree", fetcher, { refreshInterval: 5000 });
  const { data: notesData } = useSWR<{ notes: NoteMeta[] }>("/api/notes", fetcher);
  const { data: colorData } = useSWR<{ colors: Record<string, string> }>("/api/folder-colors", fetcher);
  const { data: activityData } = useSWR<{ activity: ActivityEntry[] }>(
    `/api/activity?path=${encodeURIComponent(folderPath)}&limit=8`,
    fetcher,
    { refreshInterval: 15000 },
  );

  const [q, setQ] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const d = await r.json();
        const hits: Hit[] = d.results ?? [];
        const prefix = `${folderPath}/`;
        if (seq === searchSeq.current) setResults(hits.filter((h) => h.path.startsWith(prefix)));
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, folderPath]);

  if (!treeData) {
    return <div className="scrollbar-none h-full overflow-y-auto px-8 py-10 text-sm text-muted-foreground">Loading…</div>;
  }

  const node = findDir(treeData.tree, folderPath);
  if (!node) {
    return (
      <div className="scrollbar-none h-full overflow-y-auto px-8 py-10">
        <p className="text-sm text-muted-foreground">This folder no longer exists.</p>
        <Link href="/" className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Home size={12} /> Back home
        </Link>
      </div>
    );
  }

  const notesByPath = new Map((notesData?.notes ?? []).map((n) => [n.path, n]));
  const children = [...(node.children ?? [])].sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
  );
  const activity = activityData?.activity ?? [];

  const segments = folderPath.split("/").filter(Boolean);
  const crumbs = segments.map((seg, i) => ({ name: seg, path: segments.slice(0, i + 1).join("/") }));

  return (
    <div className="scrollbar-none h-full overflow-y-auto">
      <div data-arrow-nav className="mx-auto max-w-2xl px-8 py-10">
        <nav className="mb-4 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <Link href="/" className="inline-flex shrink-0 items-center gap-1 transition-colors hover:text-foreground">
            <Home size={12} /> Home
          </Link>
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={12} className="shrink-0" />
              {i === crumbs.length - 1 ? (
                <span className="truncate text-foreground">{c.name}</span>
              ) : (
                <Link href={`/f/${c.path}`} className="truncate transition-colors hover:text-foreground">
                  {c.name}
                </Link>
              )}
            </span>
          ))}
        </nav>

        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results.length > 0) {
                e.preventDefault();
                router.push(`/n/${results[0].path}`);
              }
            }}
            data-nav-item
            placeholder={`Search in ${node.name || "vault"}…`}
            className="h-11 pl-9 text-sm"
            aria-label={`Search in ${node.name}`}
          />
        </div>

        {q.trim() ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            {results.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">{searching ? "Searching…" : "No matches in this folder."}</p>
            ) : (
              <ul className="divide-y divide-border">
                {results.slice(0, 10).map((r) => (
                  <li key={r.path}>
                    <Link href={`/n/${r.path}`} data-nav-item className={`flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent/60 ${navItemClass}`}>
                      <span className="size-1.5 shrink-0 rounded-full" style={{ background: folderColor(r.folder, colorData?.colors) }} />
                      <span className="truncate text-sm">{r.title}</span>
                      <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground">{r.path}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="mt-8 space-y-8">
            <section>
              <h2 className="mb-2 text-sm font-medium">{node.name || "Vault"}</h2>
              {children.length === 0 ? (
                <p className="text-sm text-muted-foreground">Empty folder.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {children.map((c) =>
                    c.type === "dir" ? (
                      <FolderCard key={c.path} node={c} colors={colorData?.colors} />
                    ) : (
                      <NoteCard key={c.path} node={c} meta={notesByPath.get(c.path)} />
                    ),
                  )}
                </div>
              )}
            </section>

            {activity.length > 0 && (
              <section>
                <div className="mb-1 flex items-center justify-between">
                  <h2 className="text-sm font-medium">Recent activity</h2>
                  <Link href="/activity" className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                    View all <ArrowRight size={12} />
                  </Link>
                </div>
                <ActivityList entries={activity} empty="No activity in this folder yet." />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
