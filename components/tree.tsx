"use client";

import { useState, useEffect, createContext, useContext, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { Check, ChevronRight, FileText, Palette, Pencil, Pipette, Trash2, X, GripVertical } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import type { FolderOrder } from "@/lib/vault/folder-order";

/** Parent directory of a vault-relative path ("" for something at the vault root). */
export function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function useVaultMutations() {
  const { mutate } = useSWRConfig();
  return () => {
    mutate("/api/tree");
    mutate("/api/notes");
    mutate("/api/graph");
    mutate("/api/folder-order");
  };
}

export function RenameInput({
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

/** Preset swatches — the same palette FOLDER_COLORS seeds with, plus a few extras. */
const COLOR_PRESETS = [
  "#3b82f6",
  "#a855f7",
  "#22c55e",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#ef4444",
  "#eab308",
  "#14b8a6",
  "#10b981",
  "#8b5cf6",
  "#f97316",
  "#84cc16",
  "#e11d48",
  "#64748b",
  "#71717a",
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = HEX_RE.test(hex) ? hex : "#a1a1aa";
  return { r: parseInt(m.slice(1, 3), 16), g: parseInt(m.slice(3, 5), 16), b: parseInt(m.slice(5, 7), 16) };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = (((gn - bn) / d) % 6) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const sn = s / 100,
    vn = v / 100;
  const c = vn * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = vn - c;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}

function SvField({
  hue,
  s,
  v,
  onChange,
}: {
  hue: number;
  s: number;
  v: number;
  onChange: (s: number, v: number) => void;
}) {
  function update(el: HTMLElement, clientX: number, clientY: number) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    onChange(x * 100, (1 - y) * 100);
  }
  return (
    <div
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return;
        update(e.currentTarget, e.clientX, e.clientY);
      }}
      className="relative h-32 w-full touch-none rounded-md select-none"
      style={{
        backgroundColor: `hsl(${hue}, 100%, 50%)`,
        backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
      }}
    >
      <div
        className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]"
        style={{ left: `${s}%`, top: `${100 - v}%` }}
      />
    </div>
  );
}

function HueSlider({ hue, onChange }: { hue: number; onChange: (h: number) => void }) {
  function update(el: HTMLElement, clientX: number) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onChange(x * 360);
  }
  return (
    <div
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.currentTarget, e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return;
        update(e.currentTarget, e.clientX);
      }}
      className="relative h-3 w-full touch-none rounded-full select-none"
      style={{ background: "linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)" }}
    >
      <div
        className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]"
        style={{ left: `${(hue / 360) * 100}%` }}
      />
    </div>
  );
}

export function ColorPicker({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (hex: string) => void;
  onCancel: () => void;
}) {
  const startRgb = hexToRgb(initial);
  const startHsv = rgbToHsv(startRgb.r, startRgb.g, startRgb.b);
  const [hue, setHue] = useState(startHsv.h);
  const [sat, setSat] = useState(startHsv.s);
  const [val, setVal] = useState(startHsv.v);
  const [expanded, setExpanded] = useState(false);
  const [eyedropperSupported] = useState(
    () => typeof window !== "undefined" && "EyeDropper" in window,
  );

  const { r, g, b } = hsvToRgb(hue, sat, val);
  const hex = rgbToHex(r, g, b);

  function setFromHex(next: string) {
    if (!HEX_RE.test(next)) return;
    const rgb = hexToRgb(next);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    setHue(hsv.h);
    setSat(hsv.s);
    setVal(hsv.v);
  }

  function setRgbChannel(channel: "r" | "g" | "b", value: number) {
    const clamped = Math.max(0, Math.min(255, value || 0));
    const next = { r, g, b, [channel]: clamped };
    const hsv = rgbToHsv(next.r, next.g, next.b);
    setHue(hsv.h);
    setSat(hsv.s);
    setVal(hsv.v);
  }

  async function pickWithEyedropper() {
    try {
      const ed = new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper();
      const result = await ed.open();
      const rgb = hexToRgb(result.sRGBHex);
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      setHue(hsv.h);
      setSat(hsv.s);
      setVal(hsv.v);
    } catch {
      /* user cancelled the pick */
    }
  }

  return (
    <div
      className={cn(
        "absolute z-50 mt-1 rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 transition-[width]",
        expanded ? "w-60" : "w-56",
      )}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter") onSave(hex);
      }}
    >
      <div className="grid grid-cols-8 gap-1.5">
        {COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setFromHex(c)}
            aria-label={c}
            className={cn(
              "size-5 rounded-full ring-1 ring-black/10 transition-transform hover:scale-110",
              hex.toLowerCase() === c.toLowerCase() && "ring-2 ring-foreground ring-offset-1 ring-offset-popover",
            )}
            style={{ background: c }}
          />
        ))}
      </div>

      {expanded && (
        <div className="mt-3">
          <SvField hue={hue} s={sat} v={val} onChange={(s, v) => { setSat(s); setVal(v); }} />
          <div className="mt-3 flex items-center gap-2">
            {eyedropperSupported && (
              <button
                type="button"
                onClick={pickWithEyedropper}
                title="Pick from screen"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Pipette size={13} />
              </button>
            )}
            <HueSlider hue={hue} onChange={setHue} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {([
              ["R", r, "r" as const],
              ["G", g, "g" as const],
              ["B", b, "b" as const],
            ] as const).map(([label, value, channel]) => (
              <div key={channel} className="flex flex-col items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={Math.round(value)}
                  onChange={(e) => setRgbChannel(channel, Number(e.target.value))}
                  className="w-full rounded-md border border-border bg-background px-1.5 py-1 text-center font-mono text-xs outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="text-[10px] text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Collapse" : "Custom color"}
          aria-expanded={expanded}
          className={cn(
            "relative size-6 shrink-0 rounded-full ring-1 ring-black/10 transition-shadow",
            expanded && "ring-2 ring-foreground ring-offset-1 ring-offset-popover",
          )}
          style={{ background: hex }}
        >
          <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-popover text-foreground ring-1 ring-foreground/10">
            <Palette size={9} />
          </span>
        </button>
        <input
          value={hex}
          onChange={(e) => setFromHex(e.target.value)}
          placeholder="#rrggbb"
          className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none"
        />
      </div>

      <div className="mt-3 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          title="Cancel"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={13} />
        </button>
        <button
          type="button"
          onClick={() => onSave(hex)}
          title="Save"
          className="inline-flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground"
        >
          <Check size={13} />
        </button>
      </div>
    </div>
  );
}

interface DragItem {
  id: string;
  type: "dir" | "file";
  path: string;
  name: string;
  parentPath: string;
}

interface TreeContextValue {
  activePath?: string;
  draggedItem: DragItem | null;
  dropTarget: string | null;
  isValidDropTarget: (targetPath: string) => boolean;
  colorData?: { colors: Record<string, string> };
  orderData?: { order: FolderOrder };
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
}

const TreeContext = createContext<TreeContextValue>({
  draggedItem: null,
  dropTarget: null,
  isValidDropTarget: () => false,
  expandedFolders: new Set(),
  toggleFolder: () => {},
});

const EXPANDED_FOLDERS_KEY = "engram-expanded-folders";

function isDescendantOf(childPath: string, parentPath: string): boolean {
  if (!parentPath) return false;
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function SortableDir({ 
  node, 
  depth,
}: { 
  node: TreeNode; 
  depth: number;
}) {
  const { activePath, dropTarget, isValidDropTarget, colorData, orderData, expandedFolders, toggleFolder } = useContext(TreeContext);
  const open = expandedFolders.has(node.path);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickingColor, setPickingColor] = useState(false);
  const router = useRouter();
  const refresh = useVaultMutations();
  const { mutate } = useSWRConfig();
  const color = folderColor(node.name, colorData?.colors);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `dir:${node.path}`,
    data: {
      id: `dir:${node.path}`,
      type: "dir",
      path: node.path,
      name: node.name,
      parentPath: dirOf(node.path),
    } satisfies DragItem,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isDropTarget = dropTarget === node.path && isValidDropTarget(node.path);
  const isInvalidDropTarget = dropTarget === node.path && !isValidDropTarget(node.path);

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
    setPickingColor(false);
    const res = await fetch("/api/folder-colors", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: node.name, color: hex }),
    });
    if (res.ok) mutate("/api/folder-colors");
  }

  const sortedChildren = useMemo(() => {
    if (!node.children) return [];
    const dirs = node.children.filter((c) => c.type === "dir");
    const files = node.children.filter((c) => c.type === "file");
    
    const childOrder = orderData?.order?.[node.path];
    let sortedDirs: TreeNode[];
    
    if (childOrder && childOrder.length > 0) {
      const orderMap = new Map(childOrder.map((name, idx) => [name, idx]));
      sortedDirs = [...dirs].sort((a, b) => {
        const aIdx = orderMap.get(a.name);
        const bIdx = orderMap.get(b.name);
        if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
        if (aIdx !== undefined) return -1;
        if (bIdx !== undefined) return 1;
        return a.name.localeCompare(b.name);
      });
    } else {
      sortedDirs = [...dirs].sort((a, b) => a.name.localeCompare(b.name));
    }
    
    const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name));
    return [...sortedDirs, ...sortedFiles];
  }, [node.children, node.path, orderData?.order]);

  const childDirs = sortedChildren.filter((c) => c.type === "dir");
  const childDirIds = childDirs.map((d) => `dir:${d.path}`);

  return (
    <li ref={setNodeRef} style={style} className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={() => router.push(`/f/${node.path}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter") router.push(`/f/${node.path}`);
            }}
            className={cn(
              "group flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              isDropTarget && "bg-primary/20 ring-2 ring-primary ring-inset",
              isInvalidDropTarget && "bg-destructive/10 ring-2 ring-destructive/50 ring-inset",
            )}
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <button
              type="button"
              {...attributes}
              {...listeners}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 cursor-grab touch-none opacity-0 group-hover:opacity-100 hover:text-foreground"
              aria-label="Drag to reorder"
            >
              <GripVertical size={12} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleFolder(node.path);
              }}
              className="shrink-0"
              aria-label={open ? "Collapse folder" : "Expand folder"}
            >
              <ChevronRight size={14} className={cn("transition-transform", open && "rotate-90")} />
            </button>
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
            {renaming ? (
              <RenameInput initial={node.name} onSubmit={rename} onCancel={() => setRenaming(false)} />
            ) : (
              <span className="truncate">{node.name}</span>
            )}
          </div>
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

      {open && (
        <SortableContext items={childDirIds} strategy={verticalListSortingStrategy}>
          <ul>
            {sortedChildren.map((c) =>
              c.type === "dir" ? (
                <SortableDir key={c.path} node={c} depth={depth + 1} />
              ) : (
                <DraggableFile key={c.path} node={c} depth={depth + 1} />
              ),
            )}
          </ul>
        </SortableContext>
      )}
    </li>
  );
}

function DraggableFile({ node, depth }: { node: TreeNode; depth: number }) {
  const { activePath } = useContext(TreeContext);
  const router = useRouter();
  const active = node.path === activePath;
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = useVaultMutations();
  const baseName = node.name.replace(/\.md$/i, "");

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `file:${node.path}`,
    data: {
      id: `file:${node.path}`,
      type: "file",
      path: node.path,
      name: node.name,
      parentPath: dirOf(node.path),
    } satisfies DragItem,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

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
    <li ref={setNodeRef} style={style}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => !renaming && router.push(`/n/${node.path}`)}
            className={cn(
              "group flex w-full items-center gap-1.5 truncate rounded-md py-1 pr-2 text-left transition-colors",
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <button
              type="button"
              {...attributes}
              {...listeners}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 cursor-grab touch-none opacity-0 group-hover:opacity-100 hover:text-foreground"
              aria-label="Drag to move"
            >
              <GripVertical size={12} />
            </button>
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

function DragOverlayContent({ item }: { item: DragItem }) {
  const { colorData } = useContext(TreeContext);
  
  if (item.type === "dir") {
    const color = folderColor(item.name, colorData?.colors);
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-popover px-2 py-1 text-sm shadow-lg ring-1 ring-border">
        <span className="size-1.5 rounded-full" style={{ background: color }} />
        <span>{item.name}</span>
      </div>
    );
  }
  
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-popover px-2 py-1 text-sm shadow-lg ring-1 ring-border">
      <FileText size={13} className="opacity-50" />
      <span>{item.name.replace(/\.md$/i, "")}</span>
    </div>
  );
}

export function Tree({ tree, activePath }: { tree: TreeNode; activePath?: string }) {
  const { data: colorData } = useSWR<{ colors: Record<string, string> }>("/api/folder-colors", fetcher);
  const { data: orderData, mutate: mutateOrder } = useSWR<{ order: FolderOrder }>("/api/folder-order", fetcher);
  const refresh = useVaultMutations();
  
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Persist folder expansion state in localStorage
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set<string>();
    try {
      const stored = localStorage.getItem(EXPANDED_FOLDERS_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      try {
        localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...next]));
      } catch {
        // localStorage not available
      }
      return next;
    });
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const isValidDropTarget = useCallback((targetPath: string) => {
    if (!draggedItem) return false;
    if (draggedItem.path === targetPath) return false;
    if (draggedItem.parentPath === targetPath) return false;
    if (draggedItem.type === "dir" && isDescendantOf(targetPath, draggedItem.path)) return false;
    return true;
  }, [draggedItem]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as DragItem;
    setDraggedItem(data);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const over = event.over;
    if (!over) {
      setDropTarget(null);
      return;
    }

    const overId = over.id.toString();
    if (overId.startsWith("dir:")) {
      setDropTarget(overId.slice(4));
    } else {
      setDropTarget(null);
    }
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggedItem(null);
    setDropTarget(null);

    if (!over) return;

    const activeData = active.data.current as DragItem;
    const overId = over.id.toString();
    const activeId = active.id.toString();

    if (activeId.startsWith("dir:") && overId.startsWith("dir:")) {
      const activePath = activeId.slice(4);
      const overPath = overId.slice(4);
      const activeParent = dirOf(activePath);
      const overParent = dirOf(overPath);

      if (activeParent === overParent && activePath !== overPath) {
        const parentPath = activeParent;
        const currentOrder = orderData?.order?.[parentPath] ?? [];
        
        const dirs = tree.children?.filter((c) => c.type === "dir" && dirOf(c.path) === parentPath) ?? [];
        const siblingDirs = parentPath === "" 
          ? dirs 
          : (function findSiblings(node: TreeNode, targetParent: string): TreeNode[] {
              if (node.path === targetParent) {
                return node.children?.filter((c) => c.type === "dir") ?? [];
              }
              for (const child of node.children ?? []) {
                if (child.type === "dir") {
                  const found = findSiblings(child, targetParent);
                  if (found.length > 0) return found;
                }
              }
              return [];
            })(tree, parentPath);

        const folderNames = siblingDirs.map((d) => d.name);
        if (currentOrder.length > 0) {
          const orderMap = new Map(currentOrder.map((name, idx) => [name, idx]));
          folderNames.sort((a, b) => {
            const aIdx = orderMap.get(a);
            const bIdx = orderMap.get(b);
            if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
            if (aIdx !== undefined) return -1;
            if (bIdx !== undefined) return 1;
            return a.localeCompare(b);
          });
        } else {
          folderNames.sort((a, b) => a.localeCompare(b));
        }

        const activeName = activePath.split("/").pop()!;
        const overName = overPath.split("/").pop()!;
        const oldIndex = folderNames.indexOf(activeName);
        const newIndex = folderNames.indexOf(overName);

        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const newOrder = arrayMove(folderNames, oldIndex, newIndex);
          
          await mutateOrder({ order: { ...orderData?.order, [parentPath]: newOrder } }, false);
          
          const res = await fetch("/api/folder-order", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ parentPath, folderNames: newOrder }),
          });
          
          if (!res.ok) {
            mutateOrder();
          }
        }
        return;
      }

      if (activeData.type === "dir" && !isDescendantOf(overPath, activePath) && activePath !== overPath && activeParent !== overPath) {
        const newPath = `${overPath}/${activeData.name}`;
        const res = await fetch(`/api/folders/${activePath}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: newPath }),
        });
        if (res.ok) {
          refresh();
        }
        return;
      }
    }

    if (activeId.startsWith("file:") && overId.startsWith("dir:")) {
      const filePath = activeId.slice(5);
      const targetDir = overId.slice(4);
      const fileName = filePath.split("/").pop()!;
      const currentDir = dirOf(filePath);

      if (currentDir !== targetDir && !isDescendantOf(targetDir, filePath)) {
        const newPath = `${targetDir}/${fileName}`;
        const res = await fetch(`/api/notes/${filePath}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: newPath }),
        });
        if (res.ok) {
          refresh();
        }
      }
    }
  }, [orderData, tree, mutateOrder, refresh]);

  const contextValue = useMemo<TreeContextValue>(() => ({
    activePath,
    draggedItem,
    dropTarget,
    isValidDropTarget,
    colorData,
    orderData,
    expandedFolders,
    toggleFolder,
  }), [activePath, draggedItem, dropTarget, isValidDropTarget, colorData, orderData, expandedFolders, toggleFolder]);

  const sortedRootChildren = useMemo(() => {
    if (!tree.children) return [];
    const dirs = tree.children.filter((c) => c.type === "dir");
    const files = tree.children.filter((c) => c.type === "file");
    
    const rootOrder = orderData?.order?.[""];
    let sortedDirs: TreeNode[];
    
    if (rootOrder && rootOrder.length > 0) {
      const orderMap = new Map(rootOrder.map((name, idx) => [name, idx]));
      sortedDirs = [...dirs].sort((a, b) => {
        const aIdx = orderMap.get(a.name);
        const bIdx = orderMap.get(b.name);
        if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
        if (aIdx !== undefined) return -1;
        if (bIdx !== undefined) return 1;
        return a.name.localeCompare(b.name);
      });
    } else {
      sortedDirs = [...dirs].sort((a, b) => a.name.localeCompare(b.name));
    }
    
    const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name));
    return [...sortedDirs, ...sortedFiles];
  }, [tree.children, orderData?.order]);

  const rootDirs = sortedRootChildren.filter((c) => c.type === "dir");
  const rootDirIds = rootDirs.map((d) => `dir:${d.path}`);

  return (
    <TreeContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={rootDirIds} strategy={verticalListSortingStrategy}>
          <ul className="pb-4">
            {sortedRootChildren.map((c) =>
              c.type === "dir" ? (
                <SortableDir key={c.path} node={c} depth={0} />
              ) : (
                <DraggableFile key={c.path} node={c} depth={0} />
              ),
            )}
          </ul>
        </SortableContext>
        <DragOverlay>
          {draggedItem ? <DragOverlayContent item={draggedItem} /> : null}
        </DragOverlay>
      </DndContext>
    </TreeContext.Provider>
  );
}
