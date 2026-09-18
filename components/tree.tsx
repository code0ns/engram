"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { Check, ChevronRight, FileText, Palette, Pencil, Pipette, Trash2, X } from "lucide-react";
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

/** Saturation/value field: drag to set both at once. Pointer capture on the element itself
 *  means move/up keep firing on it even once the cursor leaves its bounds mid-drag. */
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

/** Single hue slider — the "color slider" itself, as opposed to three separate R/G/B ones. */
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

/** In-app color picker — deliberately not `<input type="color">`, which opens an unstyleable
 *  OS-native dialog that clashes with everything else in the app (square corners, wrong font,
 *  no explicit save/cancel). Positioned relative to its parent `<li>` (needs `position: relative`
 *  there); matches ContextMenuContent/DialogContent styling so it looks like part of the app. */
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
      // EyeDropper isn't in the TS DOM lib yet.
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

function Dir({ node, activePath, depth }: { node: TreeNode; activePath?: string; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickingColor, setPickingColor] = useState(false);
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
    setPickingColor(false);
    const res = await fetch("/api/folder-colors", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: node.name, color: hex }),
    });
    if (res.ok) mutate("/api/folder-colors");
  }

  return (
    <li className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={() => router.push(`/f/${node.path}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter") router.push(`/f/${node.path}`);
            }}
            className="flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => !o);
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
