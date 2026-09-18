"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { ChevronRight, FileText, Palette, Pencil, Trash2 } from "lucide-react";
import { fetcher, folderColor, type TreeNode } from "@/lib/client";
import { cn } from "@/lib/utils";
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

/** Parent directory of a vault-relative path ("" for something at the vault root). */
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function useVaultMutations() {
  const { mutate } = useSWRConfig();
  return () => {
    mutate("/api/tree");
    mutate("/api/notes");
    mutate("/api/graph");
  };
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCancel()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const v = value.trim();
          if (v && v !== initial) onSubmit(v);
          else onCancel();
        }
        if (e.key === "Escape") onCancel();
      }}
      className="w-full rounded-md border border-border bg-background px-1.5 py-0.5 text-xs outline-none"
    />
  );
}

function Dir({ node, activePath, depth }: { node: TreeNode; activePath?: string; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const refresh = useVaultMutations();
  const { mutate } = useSWRConfig();
  const { data: colorData } = useSWR<{ colors: Record<string, string> }>("/api/folder-colors", fetcher);
  const color = folderColor(node.name, colorData?.colors);

  async function rename(newName: string) {
    setRenaming(false);
    const to = join(dirOf(node.path), newName);
    const res = await fetch(`/api/folders/${node.path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (res.ok) {
      refresh();
      if (activePath?.startsWith(`${node.path}/`)) router.push("/");
    }
  }

  async function doDelete() {
    setConfirmDelete(false);
    const res = await fetch(`/api/folders/${node.path}`, { method: "DELETE" });
    if (res.ok) {
      refresh();
      if (activePath?.startsWith(`${node.path}/`)) router.push("/");
    }
  }

  async function setColor(hex: string) {
    const res = await fetch("/api/folder-colors", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: node.name, color: hex }),
    });
    if (res.ok) mutate("/api/folder-colors");
  }

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <ChevronRight size={14} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
            {renaming ? (
              <RenameInput initial={node.name} onSubmit={rename} onCancel={() => setRenaming(false)} />
            ) : (
              <span className="truncate">{node.name}</span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(true)}>
            <Pencil size={13} /> Rename
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={(e) => {
              e.preventDefault();
              colorInputRef.current?.click();
            }}
          >
            <Palette size={13} /> Color…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> Delete folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <input
        ref={colorInputRef}
        type="color"
        defaultValue={/^#[0-9a-f]{6}$/i.test(color) ? color : "#a1a1aa"}
        onChange={(e) => setColor(e.target.value)}
        className="sr-only"
        aria-hidden
      />

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

      {open && (
        <ul>
          {node.children?.map((c) =>
            c.type === "dir" ? (
              <Dir key={c.path} node={c} activePath={activePath} depth={depth + 1} />
            ) : (
              <File key={c.path} node={c} activePath={activePath} depth={depth + 1} />
            ),
          )}
        </ul>
      )}
    </li>
  );
}

function File({ node, activePath, depth }: { node: TreeNode; activePath?: string; depth: number }) {
  const router = useRouter();
  const active = node.path === activePath;
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = useVaultMutations();
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
      if (active) router.push(`/n/${d.path}`);
    }
  }

  async function doDelete() {
    setConfirmDelete(false);
    const res = await fetch(`/api/notes/${node.path}`, { method: "DELETE" });
    if (res.ok) {
      refresh();
      if (active) router.push("/");
    }
  }

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => !renaming && router.push(`/n/${node.path}`)}
            className={cn(
              "flex w-full items-center gap-1.5 truncate rounded-md py-1 pr-2 text-left transition-colors",
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <FileText size={13} className="shrink-0 opacity-50" />
            {renaming ? (
              <RenameInput initial={baseName} onSubmit={rename} onCancel={() => setRenaming(false)} />
            ) : (
              <span className="truncate">{node.title || node.name}</span>
            )}
          </button>
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
    </li>
  );
}

export function Tree({ tree, activePath }: { tree: TreeNode; activePath?: string }) {
  return (
    <ul className="pb-4">
      {tree.children?.map((c) =>
        c.type === "dir" ? (
          <Dir key={c.path} node={c} activePath={activePath} depth={0} />
        ) : (
          <File key={c.path} node={c} activePath={activePath} depth={0} />
        ),
      )}
    </ul>
  );
}
