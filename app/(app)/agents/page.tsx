"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { AlertTriangle, Bot, Check, Pause, Play, Plus, RefreshCw, Square, X } from "lucide-react";
import { fetcher } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

interface Company {
  id: string;
  name: string;
  description?: string;
  status: string;
}
interface Agent {
  id: string;
  name: string;
  role: string;
  title?: string;
  companyId: string;
  reportsTo?: string | null;
  adapterType: string;
  status: "idle" | "running" | "paused" | "error" | "draft" | "terminated";
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
}
interface Approval {
  id: string;
  type: string;
  status: string;
  requestedByAgentId?: string;
  createdAt: string;
}
interface NoteMeta {
  path: string;
  title: string;
  folder: string;
}

const STATUS_STYLE: Record<Agent["status"], string> = {
  idle: "bg-secondary text-secondary-foreground",
  running: "bg-primary text-primary-foreground",
  paused: "border-border text-foreground",
  error: "bg-destructive/10 text-destructive",
  draft: "bg-secondary text-secondary-foreground",
  terminated: "border-border text-muted-foreground",
};

const ADAPTER_TYPES = [
  { id: "claude_local", label: "Claude Code (local)" },
  { id: "codex_local", label: "Codex (local)" },
  { id: "cli", label: "CLI agent (Cursor / Gemini / bash)" },
  { id: "http", label: "HTTP / webhook" },
];

/** Paperclip validates role against a fixed enum server-side — free text 400s. */
const AGENT_ROLES: { id: string; label: string }[] = [
  { id: "general", label: "General" },
  { id: "engineer", label: "Engineer" },
  { id: "designer", label: "Designer" },
  { id: "pm", label: "PM" },
  { id: "qa", label: "QA" },
  { id: "devops", label: "DevOps" },
  { id: "researcher", label: "Researcher" },
  { id: "security", label: "Security" },
  { id: "ceo", label: "CEO" },
  { id: "cto", label: "CTO" },
  { id: "cmo", label: "CMO" },
  { id: "cfo", label: "CFO" },
];

function centsToDisplay(cents?: number): string {
  if (cents === undefined) return "$0";
  return `$${(cents / 100).toFixed(0)}`;
}

/** Order agents so each one appears after whoever it reports to, indented by depth. */
function orderByHierarchy(agents: Agent[]): { agent: Agent; depth: number }[] {
  const byManager = new Map<string | null, Agent[]>();
  for (const a of agents) {
    const key = agents.some((x) => x.id === a.reportsTo) ? a.reportsTo! : null;
    if (!byManager.has(key)) byManager.set(key, []);
    byManager.get(key)!.push(a);
  }
  const out: { agent: Agent; depth: number }[] = [];
  function walk(managerId: string | null, depth: number) {
    for (const a of byManager.get(managerId) ?? []) {
      out.push({ agent: a, depth });
      walk(a.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

function NotePicker({ selected, onChange }: { selected: string[]; onChange: (paths: string[]) => void }) {
  const { data } = useSWR<{ notes: NoteMeta[] }>("/api/notes", fetcher);
  const [q, setQ] = useState("");
  const notes = (data?.notes ?? []).filter(
    (n) => n.title.toLowerCase().includes(q.toLowerCase()) || n.path.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="space-y-2">
      <Input placeholder="Filter notes…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
      <div className="scrollbar-none max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {notes.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No notes match.</p>}
        {notes.slice(0, 200).map((n) => {
          const on = selected.includes(n.path);
          return (
            <button
              type="button"
              key={n.path}
              onClick={() => onChange(on ? selected.filter((p) => p !== n.path) : [...selected, n.path])}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/50"
            >
              <span className="truncate">{n.title || n.path}</span>
              {on && <Check size={13} className="shrink-0 text-primary" />}
            </button>
          );
        })}
      </div>
      {selected.length > 0 && <p className="text-[11px] text-muted-foreground">{selected.length} note{selected.length === 1 ? "" : "s"} selected</p>}
    </div>
  );
}

export default function AgentsPage() {
  const { data: pcSettings } = useSWR<{ baseUrl: string; apiKeySet: boolean }>("/api/paperclip/settings", fetcher);
  const { data: companiesData, error: companiesError } = useSWR<{ companies: Company[] }>("/api/paperclip/companies", fetcher);
  const { mutate } = useSWRConfig();

  const companies = companiesData?.companies ?? [];
  const [companyId, setCompanyId] = useState<string | null>(null);
  const activeCompanyId = companyId ?? companies[0]?.id ?? null;
  const activeCompany = companies.find((c) => c.id === activeCompanyId);

  const { data: agentsData } = useSWR<{ agents: Agent[] }>(
    activeCompanyId ? `/api/paperclip/agents?companyId=${activeCompanyId}` : null,
    fetcher,
  );
  const { data: approvalsData } = useSWR<{ approvals: Approval[] }>(
    activeCompanyId ? `/api/paperclip/approvals?companyId=${activeCompanyId}&status=pending` : null,
    fetcher,
  );
  const agents = agentsData?.agents ?? [];
  const approvals = approvalsData?.approvals ?? [];

  function refresh() {
    if (activeCompanyId) {
      mutate(`/api/paperclip/agents?companyId=${activeCompanyId}`);
      mutate(`/api/paperclip/approvals?companyId=${activeCompanyId}&status=pending`);
    }
    mutate("/api/paperclip/companies");
  }

  // Create company
  const [newCompanyName, setNewCompanyName] = useState("");
  const [creatingCompany, setCreatingCompany] = useState(false);
  async function createCompany() {
    if (!newCompanyName.trim() || creatingCompany) return;
    setCreatingCompany(true);
    try {
      const res = await fetch("/api/paperclip/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newCompanyName.trim() }),
      });
      const d = await res.json();
      if (res.ok) {
        setNewCompanyName("");
        setCompanyId(d.id);
        mutate("/api/paperclip/companies");
      }
    } finally {
      setCreatingCompany(false);
    }
  }

  // Create agent dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    name: "",
    role: "engineer",
    title: "",
    reportsTo: "",
    adapterType: "claude_local",
    cwd: "",
    model: "",
    adapterConfigJson: "{}",
    budgetMonthlyCents: 5000,
    linkEngram: true,
    scope: "write" as "read" | "write",
    notePaths: [] as string[],
  });

  function resetForm() {
    setForm({
      name: "",
      role: "engineer",
      title: "",
      reportsTo: "",
      adapterType: "claude_local",
      cwd: "",
      model: "",
      adapterConfigJson: "{}",
      budgetMonthlyCents: 5000,
      linkEngram: true,
      scope: "write",
      notePaths: [],
    });
    setErr("");
    setEnvCheck(null);
  }

  /** Returns { adapterConfig } on success, or { error } — same rule createAgent and the environment check both need. */
  function buildAdapterConfig(): { adapterConfig: Record<string, unknown> } | { error: string } {
    if (form.adapterType === "claude_local") {
      if (!form.cwd.trim()) return { error: "Working directory (cwd) is required for Claude Code agents." };
      return { adapterConfig: { cwd: form.cwd.trim(), ...(form.model.trim() ? { model: form.model.trim() } : {}) } };
    }
    try {
      return { adapterConfig: form.adapterConfigJson.trim() ? JSON.parse(form.adapterConfigJson) : {} };
    } catch {
      return { error: "adapterConfig must be valid JSON." };
    }
  }

  const [envCheck, setEnvCheck] = useState<{ status: string; checks: { code: string; level: string; message: string; detail?: string }[] } | null>(null);
  const [checkingEnv, setCheckingEnv] = useState(false);

  async function testEnvironment() {
    if (!activeCompanyId || checkingEnv) return;
    setErr("");
    setEnvCheck(null);
    const built = buildAdapterConfig();
    if ("error" in built) return setErr(built.error);

    setCheckingEnv(true);
    try {
      const res = await fetch(`/api/paperclip/adapters/${form.adapterType}/test-environment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId: activeCompanyId, adapterConfig: built.adapterConfig }),
      });
      const d = await res.json();
      if (!res.ok) setErr(d.error || "Environment check failed.");
      else setEnvCheck(d);
    } finally {
      setCheckingEnv(false);
    }
  }

  async function createAgent() {
    if (!activeCompanyId || !form.name.trim() || busy) return;
    setErr("");

    const built = buildAdapterConfig();
    if ("error" in built) return setErr(built.error);
    const { adapterConfig } = built;

    setBusy("create");
    try {
      const res = await fetch("/api/paperclip/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompanyId,
          name: form.name.trim(),
          role: form.role,
          title: form.title.trim() || undefined,
          reportsTo: form.reportsTo || undefined,
          adapterType: form.adapterType,
          adapterConfig,
          budgetMonthlyCents: Number(form.budgetMonthlyCents) || 0,
          linkEngram: form.linkEngram ? { scope: form.scope, notePaths: form.notePaths } : undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) return setErr(d.error || "Create failed.");
      setDialogOpen(false);
      resetForm();
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function agentAction(id: string, action: "pause" | "resume" | "terminate" | "clear-error" | "heartbeat") {
    setBusy(id + action);
    try {
      await fetch(`/api/paperclip/agents/${id}/${action}`, { method: "POST" });
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, action: "approve" | "reject", decisionNote?: string) {
    setBusy(id + action);
    try {
      await fetch(`/api/paperclip/approvals/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionNote }),
      });
      refresh();
    } finally {
      setBusy(null);
    }
  }

  const ordered = useMemo(() => orderByHierarchy(agents), [agents]);
  const notReachable = !!companiesError;

  return (
    <div className="scrollbar-none h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 sm:py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Hire, monitor, and approve AI agents run by{" "}
              <span className="text-foreground">Paperclip</span>
              {activeCompany ? <> — {activeCompany.name}</> : null}. Give one Engram access and it gets this
              vault as its memory.
            </p>
          </div>
          {companies.length > 1 && (
            <Select value={activeCompanyId ?? undefined} onValueChange={setCompanyId}>
              <SelectTrigger className="w-48 shrink-0">
                <SelectValue placeholder="Company" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {notReachable && (
          <Card className="mt-8 items-center gap-2 border-dashed p-8 text-center">
            <AlertTriangle size={20} className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Can&apos;t reach Paperclip at <span className="font-mono text-foreground">{pcSettings?.baseUrl}</span>.
              Confirm it&apos;s running and check the connection in{" "}
              <Link href="/settings" className="text-foreground underline underline-offset-2">Settings</Link>.
            </p>
          </Card>
        )}

        {!notReachable && companiesData && companies.length === 0 && (
          <Card className="mt-8 items-center gap-3 border-dashed p-8 text-center">
            <Bot size={20} className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No companies yet. Create one to start hiring agents.</p>
            <div className="flex w-full max-w-xs gap-2">
              <Input
                value={newCompanyName}
                onChange={(e) => setNewCompanyName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createCompany()}
                placeholder="Company name"
              />
              <Button onClick={createCompany} disabled={creatingCompany || !newCompanyName.trim()}>
                {creatingCompany ? "Creating…" : "Create"}
              </Button>
            </div>
          </Card>
        )}

        {!notReachable && activeCompanyId && (
          <>
            {/* Approvals */}
            {approvals.length > 0 && (
              <section className="mt-8 space-y-2.5">
                <h2 className="text-sm font-medium">Pending approvals</h2>
                {approvals.map((a) => (
                  <Card key={a.id} className="flex-row items-center gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{a.type.replace(/_/g, " ")}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Requested {new Date(a.createdAt).toLocaleString()}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button size="sm" variant="outline" disabled={busy === a.id + "approve"} onClick={() => decide(a.id, "approve")}>
                        Approve
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="outline" className="text-muted-foreground hover:text-destructive">
                            Reject
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Reject this request?</AlertDialogTitle>
                            <AlertDialogDescription>The requester can resubmit after addressing your note.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => decide(a.id, "reject", "Rejected from Engram.")}>Reject</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </Card>
                ))}
              </section>
            )}

            {/* Agents */}
            <section className="mt-8 space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Team</h2>
                <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) resetForm(); }}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Plus size={14} /> New agent</Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                      <DialogTitle>Hire an agent</DialogTitle>
                      <DialogDescription>Runs under Paperclip. Optionally give it Engram as its memory.</DialogDescription>
                    </DialogHeader>

                    <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label>Name</Label>
                          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="BackendEngineer" />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Title</Label>
                          <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Senior Backend Engineer" />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label>Role</Label>
                          <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {AGENT_ROLES.map((r) => (
                                <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Reports to</Label>
                          <Select value={form.reportsTo || "none"} onValueChange={(v) => setForm((f) => ({ ...f, reportsTo: v === "none" ? "" : v }))}>
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {agents.map((a) => (
                                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label>Adapter</Label>
                        <Select value={form.adapterType} onValueChange={(v) => setForm((f) => ({ ...f, adapterType: v }))}>
                          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ADAPTER_TYPES.map((t) => (
                              <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {form.adapterType === "claude_local" ? (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label>Working directory (cwd)</Label>
                            <Input value={form.cwd} onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))} placeholder="C:\agents\backend-engineer" />
                          </div>
                          <div className="space-y-1.5">
                            <Label>Model (optional)</Label>
                            <Input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="claude-opus-4-6" />
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <Label>adapterConfig (JSON)</Label>
                          <textarea
                            value={form.adapterConfigJson}
                            onChange={(e) => setForm((f) => ({ ...f, adapterConfigJson: e.target.value }))}
                            rows={3}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none"
                          />
                        </div>
                      )}

                      <div className="space-y-2">
                        <Button type="button" size="sm" variant="outline" onClick={testEnvironment} disabled={checkingEnv}>
                          {checkingEnv ? "Checking…" : "Test environment"}
                        </Button>
                        {envCheck && (
                          <div className="space-y-1.5 rounded-lg border border-border p-3">
                            <p className={cn(
                              "text-xs font-medium",
                              envCheck.status === "pass" ? "text-emerald-500" : envCheck.status === "warn" ? "text-amber-500" : "text-destructive",
                            )}>
                              {envCheck.status === "pass" ? "Ready" : envCheck.status === "warn" ? "Runs, with warnings" : "Not ready"}
                            </p>
                            <div className="space-y-1">
                              {envCheck.checks.map((c, i) => (
                                <div key={i} className="text-xs">
                                  <span className={cn(
                                    c.level === "error" ? "text-destructive" : c.level === "warn" ? "text-amber-500" : "text-muted-foreground",
                                  )}>
                                    {c.level === "error" ? "✕" : c.level === "warn" ? "!" : "✓"} {c.message}
                                  </span>
                                  {c.detail && <p className="ml-4 text-[11px] text-muted-foreground">{c.detail}</p>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label>Budget (cents / month)</Label>
                        <Input
                          type="number"
                          value={form.budgetMonthlyCents}
                          onChange={(e) => setForm((f) => ({ ...f, budgetMonthlyCents: Number(e.target.value) }))}
                        />
                      </div>

                      <div className="space-y-2 rounded-lg border border-border p-3">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={form.linkEngram}
                            onChange={(e) => setForm((f) => ({ ...f, linkEngram: e.target.checked }))}
                          />
                          Link to Engram
                        </label>
                        <p className="text-xs text-muted-foreground">
                          Mints an MCP token for this agent and (for Claude Code) drops a{" "}
                          <code className="rounded bg-muted px-1">.mcp.json</code> into its working directory.
                        </p>
                        {form.linkEngram && (
                          <div className="space-y-2 pt-1">
                            <div className="inline-flex rounded-md border border-border p-0.5" role="group">
                              {(["read", "write"] as const).map((sc) => (
                                <button
                                  key={sc}
                                  type="button"
                                  onClick={() => setForm((f) => ({ ...f, scope: sc }))}
                                  className={cn(
                                    "rounded px-3 py-1 text-xs font-medium capitalize transition-colors",
                                    form.scope === sc ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  {sc}
                                </button>
                              ))}
                            </div>
                            <NotePicker selected={form.notePaths} onChange={(p) => setForm((f) => ({ ...f, notePaths: p }))} />
                          </div>
                        )}
                      </div>

                      {err && <p className="text-xs text-destructive">{err}</p>}
                    </div>

                    <DialogFooter>
                      <Button onClick={createAgent} disabled={busy === "create" || !form.name.trim()}>
                        {busy === "create" ? "Hiring…" : "Hire"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>

              {ordered.length === 0 ? (
                <Card className="items-center gap-2 border-dashed p-8 text-center">
                  <Bot size={20} className="text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No agents yet. Hire your first one.</p>
                </Card>
              ) : (
                ordered.map(({ agent, depth }) => {
                  const spent = agent.spentMonthlyCents ?? 0;
                  const budget = agent.budgetMonthlyCents ?? 0;
                  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
                  return (
                    <Card key={agent.id} className="flex-row items-center gap-4 p-4" style={{ marginLeft: depth * 20 }}>
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground">
                        <Bot size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Link href={`/agents/${agent.id}`} className="truncate text-sm font-medium hover:underline">
                            {agent.name}
                          </Link>
                          <Badge className={cn("h-5 px-1.5 text-[10px]", STATUS_STYLE[agent.status])}>{agent.status}</Badge>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {agent.title || agent.role} · <span className="font-mono">{agent.adapterType}</span>
                        </p>
                        {budget > 0 && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                              <div className={cn("h-full rounded-full", pct >= 100 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-[11px] text-muted-foreground">
                              {centsToDisplay(spent)} / {centsToDisplay(budget)}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 text-muted-foreground"
                          title="Run now"
                          disabled={busy === agent.id + "heartbeat"}
                          onClick={() => agentAction(agent.id, "heartbeat")}
                        >
                          <RefreshCw size={14} />
                        </Button>
                        {agent.status === "paused" ? (
                          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="Resume" onClick={() => agentAction(agent.id, "resume")}>
                            <Play size={14} />
                          </Button>
                        ) : (
                          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="Pause" onClick={() => agentAction(agent.id, "pause")}>
                            <Pause size={14} />
                          </Button>
                        )}
                        {agent.status === "error" && (
                          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="Clear error" onClick={() => agentAction(agent.id, "clear-error")}>
                            <X size={14} />
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" title="Terminate">
                              <Square size={14} />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Terminate &ldquo;{agent.name}&rdquo;?</AlertDialogTitle>
                              <AlertDialogDescription>Permanently deactivates this agent. This cannot be undone.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => agentAction(agent.id, "terminate")}>Terminate</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </Card>
                  );
                })
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
