"use client";

import Link from "next/link";
import useSWR, { useSWRConfig } from "swr";
import { useState } from "react";
import { Plus, Shield, Trash2 } from "lucide-react";
import { fetcher } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface Repo {
  id: string;
  name: string;
}
interface AccessGrant {
  email: string;
  workspaceIds: string[];
}
interface AccessResponse {
  authEnforced: boolean;
  grants: AccessGrant[];
  repos: Repo[];
  allowedEmails: string[];
}
interface TokenMeta {
  id: string;
  name: string;
  scope: "read" | "write";
  workspaceId?: string;
}

function refresh(mutate: (key: string) => unknown) {
  mutate("/api/access");
  mutate("/api/tokens");
}

/** Checkbox list of workspaces, shared by the add and edit flows. */
function WorkspacePicker({ repos, selected, onChange }: { repos: Repo[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="scrollbar-none max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
      {repos.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No workspaces yet — add one on the Workspaces page first.</p>}
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

export default function AccessPage() {
  const { data } = useSWR<AccessResponse>("/api/access", fetcher);
  const { data: tokenData } = useSWR<{ tokens: TokenMeta[] }>("/api/tokens", fetcher);
  const { mutate } = useSWRConfig();

  const repos = data?.repos ?? [];
  const grants = data?.grants ?? [];
  const tokens = tokenData?.tokens ?? [];
  const repoName = (id?: string) => (id ? repos.find((r) => r.id === id)?.name : undefined);
  const grantedEmails = new Set(grants.map((g) => g.email));
  const ungranted = (data?.allowedEmails ?? []).filter((e) => !grantedEmails.has(e));

  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newWorkspaces, setNewWorkspaces] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const [editing, setEditing] = useState<{ email: string; workspaceIds: string[] } | null>(null);

  async function grant(email: string, workspaceIds: string[]) {
    setBusy(email);
    setErr("");
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, workspaceIds }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.error || "failed"); return false; }
      refresh(mutate);
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function remove(email: string) {
    setBusy(email);
    try {
      await fetch(`/api/access?email=${encodeURIComponent(email)}`, { method: "DELETE" });
      refresh(mutate);
    } finally {
      setBusy(null);
    }
  }

  if (data && !data.authEnforced) {
    return (
      <div className="scrollbar-none h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 sm:py-10">
          <h1 className="text-2xl font-semibold tracking-tight">Access</h1>
          <Card className="mt-8 items-center gap-2 border-dashed p-8 text-center">
            <Shield size={20} className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Auth isn&apos;t configured on this instance (local/no-auth mode) — everyone who can reach
              it sees every workspace. Set <code className="rounded bg-muted px-1">AUTH_SECRET</code> to enable
              per-person access control.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="scrollbar-none h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 sm:py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Access</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Who can see which workspace. Logging in at all is still gated by{" "}
              <code className="rounded bg-muted px-1">ALLOWED_EMAILS</code> on the host — this is the
              finer-grained layer underneath: which of those people see which vault.
            </p>
          </div>
          <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); setErr(""); if (!o) { setNewEmail(""); setNewWorkspaces([]); } }}>
            <DialogTrigger asChild>
              <Button className="shrink-0"><Plus size={15} /> Add access</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Grant workspace access</DialogTitle>
                <DialogDescription>The email must already be in ALLOWED_EMAILS, or they still can&apos;t log in.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="grantEmail">Email</Label>
                  <Input id="grantEmail" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="teammate@company.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>Workspaces</Label>
                  <WorkspacePicker repos={repos} selected={newWorkspaces} onChange={setNewWorkspaces} />
                </div>
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
              <DialogFooter>
                <Button
                  disabled={busy === newEmail.trim() || !newEmail.trim()}
                  onClick={async () => {
                    if (await grant(newEmail.trim().toLowerCase(), newWorkspaces)) {
                      setAddOpen(false);
                      setNewEmail("");
                      setNewWorkspaces([]);
                    }
                  }}
                >
                  Grant
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {ungranted.length > 0 && (
          <Card className="mt-8 gap-2 border-dashed p-4">
            <p className="text-xs text-muted-foreground">
              Can log in but have no workspace yet — they&apos;ll see nothing until granted one:{" "}
              <span className="text-foreground">{ungranted.join(", ")}</span>
            </p>
          </Card>
        )}

        <section className="mt-6 space-y-2.5">
          <h2 className="text-sm font-medium">People</h2>
          {grants.length === 0 ? (
            <Card className="items-center gap-2 border-dashed p-8 text-center">
              <Shield size={20} className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No one has scoped access yet.</p>
            </Card>
          ) : (
            grants.map((g) => (
              <Card key={g.email} className="flex-row items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{g.email}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {g.workspaceIds.length === 0 ? (
                      <span className="text-xs text-muted-foreground">no workspaces</span>
                    ) : (
                      g.workspaceIds.map((id) => (
                        <Badge key={id} variant="outline" className="h-5 px-1.5 text-[10px]">
                          {repoName(id) ?? "(deleted workspace)"}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Dialog
                    open={editing?.email === g.email}
                    onOpenChange={(o) => setEditing(o ? { email: g.email, workspaceIds: g.workspaceIds } : null)}
                  >
                    <DialogTrigger asChild>
                      <Button size="sm" variant="outline">Edit</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Edit access for {g.email}</DialogTitle>
                      </DialogHeader>
                      {editing && (
                        <WorkspacePicker repos={repos} selected={editing.workspaceIds} onChange={(ids) => setEditing({ email: g.email, workspaceIds: ids })} />
                      )}
                      <DialogFooter>
                        <Button
                          disabled={busy === g.email}
                          onClick={async () => {
                            if (editing && (await grant(g.email, editing.workspaceIds))) setEditing(null);
                          }}
                        >
                          Save
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" title="Revoke all access">
                        <Trash2 size={14} />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke all access for {g.email}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          They stay on ALLOWED_EMAILS (can still log in) but won&apos;t see any workspace until re-granted.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => remove(g.email)}>Revoke</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </Card>
            ))
          )}
        </section>

        <section className="mt-8 space-y-2.5 border-t border-border pt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">MCP tokens</h2>
            <Link href="/connect" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Manage on Connect →
            </Link>
          </div>
          {tokens.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tokens yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Scope</th>
                    <th className="px-3 py-2 font-medium">Workspace</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">{t.name}</td>
                      <td className="px-3 py-2">
                        <span className={cn("text-xs", t.scope === "read" ? "text-muted-foreground" : "text-foreground")}>
                          {t.scope === "read" ? "read-only" : "read & write"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {t.workspaceId ? (
                          <span className="text-xs">{repoName(t.workspaceId) ?? "(deleted workspace)"}</span>
                        ) : (
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground">unscoped — legacy</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
