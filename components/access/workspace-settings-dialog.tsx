"use client";

import useSWR, { useSWRConfig } from "swr";
import { useState } from "react";
import { fetcher } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Repo, TregSettings } from "./types";

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

function Field({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Parse a cap input: blank = reset to the server default (null), otherwise a positive number. */
function parseCap(raw: string, label: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number of dollars`);
  return n;
}

function SettingsForm({ repo, treg, isAdmin, onClose }: { repo: Repo; treg: TregSettings; isAdmin: boolean; onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const [name, setName] = useState(repo.name);
  const [token, setToken] = useState("");
  const [org, setOrg] = useState(treg.overrides.orgId ? treg.orgId : "");
  const [perCall, setPerCall] = useState(treg.overrides.perCallCapUsd ? String(treg.perCallCapUsd) : "");
  const [daily, setDaily] = useState(treg.overrides.dailyCapUsd ? String(treg.dailyCapUsd) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const treg$ = `/api/repos/${repo.id}/treg`;
  const pct = treg.dailyCapUsd > 0 ? Math.min(100, (treg.spentTodayUsd / treg.dailyCapUsd) * 100) : 0;

  async function put(body: Record<string, unknown>) {
    const res = await fetch(treg$, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "save failed");
  }

  async function save() {
    setErr("");
    setSaving(true);
    try {
      if (name.trim() && name.trim() !== repo.name) {
        const res = await fetch(`/api/repos/${repo.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "rename failed");
      }
      const body: Record<string, unknown> = {
        orgId: org.trim() || null,
        perCallCapUsd: parseCap(perCall, "Per-call cap"),
        dailyCapUsd: parseCap(daily, "Daily cap"),
      };
      if (token.trim()) body.token = token.trim();
      await put(body);
      mutate("/api/repos");
      mutate(treg$);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function removeToken() {
    setErr("");
    try {
      await put({ clearToken: true });
      mutate(treg$);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const status = treg.hasToken
    ? "This workspace uses its own Treg token."
    : treg.globalAvailable
      ? "No token of its own — using the shared server token (TREG_TOKEN)."
      : "Treg tools are off for this workspace — no token set.";

  return (
    <>
      <div className="space-y-5">
        <Field>
          <Label htmlFor="wsName">Name</Label>
          {isAdmin ? (
            <Input id="wsName" value={name} onChange={(e) => setName(e.target.value)} />
          ) : (
            <p className="text-sm">{repo.name}</p>
          )}
        </Field>

        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <h3 className="text-sm font-medium">Tool budget (Treg)</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Lets agents on this workspace discover and call paid outside APIs. {status}
            </p>
          </div>

          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">Spent today (UTC)</span>
              <span>
                {usd(treg.spentTodayUsd)} <span className="text-muted-foreground">of {usd(treg.dailyCapUsd)}</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={`h-full ${pct >= 90 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] text-muted-foreground">Per-call cap {usd(treg.perCallCapUsd)}. A call over either cap is refused.</p>
          </div>

          {isAdmin ? (
            <>
              <Field hint={treg.hasToken ? "A token is set. Type a new value to replace it." : "Optional — blank uses the shared server token."}>
                <Label htmlFor="tregToken">
                  Treg token {treg.hasToken && <span className="text-primary">• set</span>}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="tregToken"
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={treg.hasToken ? "••••••••••••••••" : "paste a Treg token"}
                  />
                  {treg.hasToken && (
                    <Button variant="outline" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={removeToken}>
                      Remove
                    </Button>
                  )}
                </div>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field hint="Blank = server default.">
                  <Label htmlFor="perCall">Per-call cap ($)</Label>
                  <Input
                    id="perCall"
                    inputMode="decimal"
                    value={perCall}
                    onChange={(e) => setPerCall(e.target.value)}
                    placeholder={String(treg.perCallCapUsd)}
                  />
                </Field>
                <Field hint="Blank = server default.">
                  <Label htmlFor="daily">Daily cap ($)</Label>
                  <Input id="daily" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={String(treg.dailyCapUsd)} />
                </Field>
              </div>

              <Field hint="Org ID or team slug. Only the balance tool needs it.">
                <Label htmlFor="tregOrg">Org (optional)</Label>
                <Input id="tregOrg" value={org} onChange={(e) => setOrg(e.target.value)} placeholder={treg.orgId || "e.g. harold-builds"} />
              </Field>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Only admins can change the token and limits.</p>
          )}
        </div>

        {err && <p className="text-xs text-destructive">{err}</p>}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {isAdmin ? "Cancel" : "Close"}
        </Button>
        {isAdmin && (
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** Per-workspace settings: name, and the Treg token + spend limits. Open when `repo` is set. */
export function WorkspaceSettingsDialog({ repo, isAdmin, onClose }: { repo: Repo | null; isAdmin: boolean; onClose: () => void }) {
  const { data: treg } = useSWR<TregSettings>(repo ? `/api/repos/${repo.id}/treg` : null, fetcher);

  return (
    <Dialog open={repo !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {repo?.name} <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">settings</Badge>
          </DialogTitle>
          <DialogDescription>
            {repo ? (repo.fullName ?? repo.url.replace(/^https?:\/\//, "").replace(/\.git$/, "")) : ""}
          </DialogDescription>
        </DialogHeader>
        {repo && treg ? (
          <SettingsForm key={repo.id} repo={repo} treg={treg} isAdmin={isAdmin} onClose={onClose} />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
