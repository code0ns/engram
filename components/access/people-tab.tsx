"use client";

import useSWR, { useSWRConfig } from "swr";
import { useState } from "react";
import { Plus, Shield, Trash2 } from "lucide-react";
import { fetcher } from "@/lib/client";
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
import { WorkspacePicker } from "./workspace-picker";
import type { AccessResponse } from "./types";

export function PeopleTab() {
  const { data } = useSWR<AccessResponse>("/api/access", fetcher);
  const { mutate } = useSWRConfig();

  const repos = data?.repos ?? [];
  const grants = data?.grants ?? [];
  const isAdmin = data?.me.isAdmin ?? false;
  const repoName = (id?: string) => (id ? repos.find((r) => r.id === id)?.name : undefined);
  const grantedEmails = new Set(grants.map((g) => g.email));
  const ungranted = (data?.allowedEmails ?? []).filter((e) => !grantedEmails.has(e));

  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newWorkspaces, setNewWorkspaces] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [pageErr, setPageErr] = useState("");

  const [editing, setEditing] = useState<{ email: string; workspaceIds: string[] } | null>(null);

  /** POST /api/access — returns the error message, or null on success. */
  async function post(body: Record<string, unknown>, busyKey: string): Promise<string | null> {
    setBusy(busyKey);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return d.error || "failed";
      mutate("/api/access");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function grant(email: string, workspaceIds: string[]) {
    setErr("");
    const e = await post({ email, workspaceIds }, email);
    if (e) setErr(e);
    return !e;
  }

  async function toggleAdmin(email: string, on: boolean) {
    setPageErr("");
    const e = await post({ email, isAdmin: on }, `admin-${email}`);
    if (e) setPageErr(e);
  }

  async function remove(email: string) {
    setBusy(email);
    setPageErr("");
    try {
      const res = await fetch(`/api/access?email=${encodeURIComponent(email)}`, { method: "DELETE" });
      if (!res.ok) setPageErr((await res.json().catch(() => ({}))).error || "failed");
      mutate("/api/access");
    } finally {
      setBusy(null);
    }
  }

  if (data && !data.authEnforced) {
    return (
      <Card className="items-center gap-2 border-dashed p-8 text-center">
        <Shield size={20} className="text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Auth isn&apos;t configured on this instance (local/no-auth mode) — everyone who can reach it sees every
          workspace. Set <code className="rounded bg-muted px-1">AUTH_SECRET</code> to enable per-person access control.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          Who can see which workspace. Logging in at all is still gated by{" "}
          <code className="rounded bg-muted px-1">ALLOWED_EMAILS</code> on the host — this is the finer-grained layer
          underneath. <span className="text-foreground">Admins</span> manage access, workspace settings and tool budgets;
          everyone else can use the workspaces they&apos;re granted.
        </p>
        {isAdmin && (
          <Dialog
            open={addOpen}
            onOpenChange={(o) => {
              setAddOpen(o);
              setErr("");
              if (!o) {
                setNewEmail("");
                setNewWorkspaces([]);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button className="shrink-0">
                <Plus size={15} /> Add access
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Grant workspace access</DialogTitle>
                <DialogDescription>
                  The email must already be in ALLOWED_EMAILS, or they still can&apos;t log in.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="grantEmail">Email</Label>
                  <Input
                    id="grantEmail"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="teammate@company.com"
                  />
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
        )}
      </div>

      {isAdmin && ungranted.length > 0 && (
        <Card className="gap-2 border-dashed p-4">
          <p className="text-xs text-muted-foreground">
            Can log in but have no workspace yet — they&apos;ll see nothing until granted one:{" "}
            <span className="text-foreground">{ungranted.join(", ")}</span>
          </p>
        </Card>
      )}

      {pageErr && <p className="text-xs text-destructive">{pageErr}</p>}

      <section className="space-y-2.5">
        <h2 className="text-sm font-medium">People</h2>
        {grants.length === 0 ? (
          <Card className="items-center gap-2 border-dashed p-8 text-center">
            <Shield size={20} className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No one has scoped access yet.</p>
          </Card>
        ) : (
          grants.map((g) => {
            const isMe = g.email === data?.me.email;
            return (
              <Card key={g.email} className="flex-row items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{g.email}</p>
                    {g.isAdmin && <Badge className="h-5 px-1.5 text-[10px]">Admin</Badge>}
                    {isMe && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">you</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {g.workspaceIds.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No access</span>
                    ) : (
                      g.workspaceIds.map((id) => (
                        <Badge key={id} variant="outline" className="h-5 px-1.5 text-[10px]">
                          {repoName(id) ?? "(deleted workspace)"}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      disabled={busy === `admin-${g.email}`}
                      onClick={() => toggleAdmin(g.email, !g.isAdmin)}
                    >
                      {g.isAdmin ? "Remove admin" : "Make admin"}
                    </Button>
                    <Dialog
                      open={editing?.email === g.email}
                      onOpenChange={(o) => {
                        setErr("");
                        setEditing(o ? { email: g.email, workspaceIds: g.workspaceIds } : null);
                      }}
                    >
                      <DialogTrigger asChild>
                        <Button size="sm" variant="outline">
                          Edit
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Edit access for {g.email}</DialogTitle>
                        </DialogHeader>
                        {editing && (
                          <WorkspacePicker
                            repos={repos}
                            selected={editing.workspaceIds}
                            onChange={(ids) => setEditing({ email: g.email, workspaceIds: ids })}
                          />
                        )}
                        {err && <p className="text-xs text-destructive">{err}</p>}
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
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          title="Revoke all access"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Revoke all access for {g.email}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            They stay on ALLOWED_EMAILS (can still log in) but won&apos;t see any workspace until
                            re-granted. Admin rights are removed too.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove(g.email)}>Revoke</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </Card>
            );
          })
        )}
      </section>
    </div>
  );
}
