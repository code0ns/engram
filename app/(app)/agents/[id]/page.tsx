"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { ArrowLeft, Plus, RotateCcw } from "lucide-react";
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

interface Agent {
  id: string;
  name: string;
  role: string;
  title?: string;
  companyId: string;
  reportsTo?: string | null;
  capabilities?: string;
  status: string;
  adapterType: string;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
  chainOfCommand?: { id: string; name: string; role: string }[];
}
interface AgentLink {
  paperclipAgentId: string;
  engramTokenId: string;
  briefingNotePaths: string[];
}
interface ConfigRevision {
  id: string;
  createdAt: string;
  summary?: string;
}
interface Issue {
  id: string;
  title: string;
  status: string;
  priority?: string;
  updatedAt?: string;
}
interface ActivityRecord {
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  idle: "bg-secondary text-secondary-foreground",
  running: "bg-primary text-primary-foreground",
  paused: "border-border text-foreground",
  error: "bg-destructive/10 text-destructive",
  draft: "bg-secondary text-secondary-foreground",
  terminated: "border-border text-muted-foreground",
};

const ISSUE_OPEN_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agent, error } = useSWR<Agent>(`/api/paperclip/agents/${id}`, fetcher);
  const { data: linkData } = useSWR<{ link: AgentLink | null }>(`/api/paperclip/agents/${id}/link`, fetcher);
  const { data: revData } = useSWR<{ revisions: ConfigRevision[] }>(`/api/paperclip/agents/${id}/config-revisions`, fetcher);
  const { data: issuesData } = useSWR<{ issues: Issue[] }>(
    agent ? `/api/paperclip/issues?companyId=${agent.companyId}&assigneeAgentId=${id}` : null,
    fetcher,
  );
  const { data: activityData } = useSWR<{ activity: ActivityRecord[] }>(
    agent ? `/api/paperclip/activity?companyId=${agent.companyId}&agentId=${id}` : null,
    fetcher,
  );
  const { mutate } = useSWRConfig();

  const link = linkData?.link ?? null;
  const revisions = revData?.revisions ?? [];
  const openIssues = (issuesData?.issues ?? []).filter((i) => ISSUE_OPEN_STATUSES.has(i.status));
  const activity = (activityData?.activity ?? []).slice(0, 15);

  const [title, setTitle] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [budget, setBudget] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!agent) return;
    setTitle(agent.title ?? "");
    setCapabilities(agent.capabilities ?? "");
    setBudget(agent.budgetMonthlyCents ?? 0);
  }, [agent]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await fetch(`/api/paperclip/agents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, capabilities, budgetMonthlyCents: Number(budget) || 0 }),
      });
      mutate(`/api/paperclip/agents/${id}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function rollback(revisionId: string) {
    await fetch(`/api/paperclip/agents/${id}/config-revisions/${revisionId}/rollback`, { method: "POST" });
    mutate(`/api/paperclip/agents/${id}`);
    mutate(`/api/paperclip/agents/${id}/config-revisions`);
  }

  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [taskErr, setTaskErr] = useState("");

  async function assignTask() {
    if (!agent || !taskTitle.trim() || assigning) return;
    setAssigning(true);
    setTaskErr("");
    try {
      const res = await fetch("/api/paperclip/issues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyId: agent.companyId,
          title: taskTitle.trim(),
          description: taskDescription.trim() || undefined,
          assigneeAgentId: id,
        }),
      });
      const d = await res.json();
      if (!res.ok) return setTaskErr(d.error || "Couldn't create the task.");
      setTaskTitle("");
      setTaskDescription("");
      setTaskDialogOpen(false);
      mutate(`/api/paperclip/issues?companyId=${agent.companyId}&assigneeAgentId=${id}`);
    } finally {
      setAssigning(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10 text-sm text-muted-foreground">
        Couldn&apos;t load this agent. <Link href="/agents" className="underline">Back to Agents</Link>
      </div>
    );
  }
  if (!agent) return <div className="px-8 py-10 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="scrollbar-none h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 sm:py-10">
        <Link href="/agents" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft size={13} /> Agents
        </Link>

        <div className="mt-3 flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <Badge className={cn("h-5 px-1.5 text-[10px]", STATUS_STYLE[agent.status] ?? "")}>{agent.status}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {agent.role} · <span className="font-mono">{agent.adapterType}</span>
        </p>

        {/* Config */}
        <section className="mt-8 space-y-4 border-t border-border pt-6">
          <h2 className="text-sm font-medium">Configuration</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Budget (cents / month)</Label>
              <Input type="number" value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Capabilities</Label>
            <textarea
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none"
            />
          </div>
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
          </Button>
        </section>

        {/* Chain of command */}
        {agent.chainOfCommand && agent.chainOfCommand.length > 0 && (
          <section className="mt-6 space-y-2 border-t border-border pt-6">
            <h2 className="text-sm font-medium">Chain of command</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              {agent.chainOfCommand.map((c, i) => (
                <span key={c.id} className="flex items-center gap-1.5">
                  {i > 0 && <span>›</span>}
                  <Link href={`/agents/${c.id}`} className="hover:text-foreground hover:underline">{c.name}</Link>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Currently working on */}
        <section className="mt-6 space-y-2 border-t border-border pt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Currently working on</h2>
            <Dialog open={taskDialogOpen} onOpenChange={(o) => { setTaskDialogOpen(o); if (!o) setTaskErr(""); }}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Plus size={13} /> Assign a task
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Assign a task</DialogTitle>
                  <DialogDescription>Creates a Paperclip issue assigned to {agent.name}. It picks it up on its next heartbeat.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="taskTitle">Title</Label>
                    <Input id="taskTitle" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Summarize last week's client notes" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="taskDescription">Description (optional)</Label>
                    <textarea
                      id="taskDescription"
                      value={taskDescription}
                      onChange={(e) => setTaskDescription(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none"
                      placeholder="Any context the agent needs — what to look at, what done looks like…"
                    />
                  </div>
                  {taskErr && <p className="text-xs text-destructive">{taskErr}</p>}
                </div>
                <DialogFooter>
                  <Button onClick={assignTask} disabled={assigning || !taskTitle.trim()}>
                    {assigning ? "Assigning…" : "Assign"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
          {openIssues.length === 0 ? (
            <p className="text-xs text-muted-foreground">No open issues assigned.</p>
          ) : (
            <div className="scrollbar-none divide-y divide-border rounded-lg border border-border">
              {openIssues.map((iss) => (
                <div key={iss.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <p className="truncate text-xs">{iss.title}</p>
                  <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">{iss.status.replace(/_/g, " ")}</Badge>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent activity */}
        <section className="mt-6 space-y-2 border-t border-border pt-6">
          <h2 className="text-sm font-medium">Recent activity</h2>
          {activity.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing logged yet.</p>
          ) : (
            <div className="scrollbar-none divide-y divide-border rounded-lg border border-border">
              {activity.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="truncate text-muted-foreground">
                    {a.action.replace(/_/g, " ")} <span className="text-foreground">{a.entityType}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Engram link */}
        <section className="mt-6 space-y-2 border-t border-border pt-6">
          <h2 className="text-sm font-medium">Engram</h2>
          {!link ? (
            <p className="text-xs text-muted-foreground">Not linked to Engram. Re-hire with &ldquo;Link to Engram&rdquo; checked to attach it.</p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                Connected via MCP token — manage or revoke on the{" "}
                <Link href="/connect" className="text-foreground underline underline-offset-2">Connect page</Link>.
              </p>
              {link.briefingNotePaths.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {link.briefingNotePaths.map((p) => (
                    <Link key={p} href={`/n/${p}`} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50">
                      {p}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Config revisions */}
        {revisions.length > 0 && (
          <section className="mt-6 space-y-2 border-t border-border pt-6">
            <h2 className="text-sm font-medium">Config history</h2>
            <div className="scrollbar-none divide-y divide-border rounded-lg border border-border">
              {revisions.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs">{r.summary || "Config change"}</p>
                    <p className="text-[11px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => rollback(r.id)}>
                    <RotateCcw size={13} /> Rollback
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        <Card className="mt-8 p-4 text-xs text-muted-foreground">
          Pause, resume, run now, and terminate live on the{" "}
          <Link href="/agents" className="text-foreground underline underline-offset-2">Agents list</Link>.
        </Card>
      </div>
    </div>
  );
}
