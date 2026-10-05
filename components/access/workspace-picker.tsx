"use client";

import { cn } from "@/lib/utils";
import type { Repo } from "./types";

/** Checkbox list of workspaces — used when granting a person access and when scoping a token. */
export function WorkspacePicker({
  repos,
  selected,
  onChange,
  compact = false,
}: {
  repos: Pick<Repo, "id" | "name">[];
  selected: string[];
  onChange: (ids: string[]) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "scrollbar-none divide-y divide-border overflow-y-auto rounded-lg border border-border",
        compact ? "max-h-32" : "max-h-40",
      )}
    >
      {repos.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground">No workspaces yet — add one on the Workspaces tab first.</p>
      )}
      {repos.map((r) => {
        const on = selected.includes(r.id);
        return (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50">
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? selected.filter((id) => id !== r.id) : [...selected, r.id])}
            />
            {r.name}
          </label>
        );
      })}
    </div>
  );
}
