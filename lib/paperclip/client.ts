import { paperclipApiKey, paperclipBaseUrl } from "@/lib/paperclip/settings";

/**
 * Thin server-side wrapper around Paperclip's REST API (see paperclip/docs/api/*.md).
 * Server-only so the API key never reaches the browser — matches the reasoning behind
 * lib/github.ts holding the GitHub client secret. No SDK; Paperclip is plain JSON+fetch.
 */

export class PaperclipError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "PaperclipError";
  }
}

/** Run a route handler body, mapping a PaperclipError (or anything else) to a JSON error response. */
export async function pcRoute<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (e) {
    const status = e instanceof PaperclipError ? e.status : 500;
    return Response.json({ error: e instanceof Error ? e.message : "request failed" }, { status });
  }
}

async function pc<T>(path: string, init?: RequestInit): Promise<T> {
  const key = paperclipApiKey();
  const res = await fetch(`${paperclipBaseUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new PaperclipError(res.status, body.error || `Paperclip request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Companies ────────────────────────────────────────────────────────────────

export interface Company {
  id: string;
  name: string;
  description?: string;
  status: "active" | "paused" | "archived";
  budgetMonthlyCents?: number;
  logoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export const listCompanies = () => pc<Company[]>("/companies");
export const getCompany = (id: string) => pc<Company>(`/companies/${id}`);
export const createCompany = (name: string, description?: string) =>
  pc<Company>("/companies", { method: "POST", body: JSON.stringify({ name, description }) });
export const updateCompany = (id: string, patch: Partial<Company>) =>
  pc<Company>(`/companies/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// ── Agents ───────────────────────────────────────────────────────────────────

export type AgentStatus = "idle" | "running" | "paused" | "error" | "draft" | "terminated";

export interface Agent {
  id: string;
  name: string;
  role: string;
  title?: string;
  companyId: string;
  reportsTo?: string | null;
  capabilities?: string;
  status: AgentStatus;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
  chainOfCommand?: { id: string; name: string; role: string }[];
}

export interface CreateAgentInput {
  name: string;
  role: string;
  title?: string;
  reportsTo?: string;
  capabilities?: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  budgetMonthlyCents?: number;
}

export const listAgents = (companyId: string) => pc<Agent[]>(`/companies/${companyId}/agents`);
export const getAgent = (id: string) => pc<Agent>(`/agents/${id}`);
export const createAgent = (companyId: string, body: CreateAgentInput) =>
  pc<Agent>(`/companies/${companyId}/agents`, { method: "POST", body: JSON.stringify(body) });
export const updateAgent = (id: string, patch: Partial<CreateAgentInput>) =>
  pc<Agent>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const pauseAgent = (id: string) => pc<Agent>(`/agents/${id}/pause`, { method: "POST" });
export const resumeAgent = (id: string) => pc<Agent>(`/agents/${id}/resume`, { method: "POST" });
export const clearAgentError = (id: string) => pc<Agent>(`/agents/${id}/clear-error`, { method: "POST" });
export const terminateAgent = (id: string) => pc<Agent>(`/agents/${id}/terminate`, { method: "POST" });
export const invokeHeartbeat = (id: string) => pc<{ ok: boolean }>(`/agents/${id}/heartbeat/invoke`, { method: "POST" });

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  title?: string;
  reportsTo?: string | null;
}
export const getOrg = (companyId: string) => pc<OrgNode[]>(`/companies/${companyId}/org`);

export interface ConfigRevision {
  id: string;
  createdAt: string;
  summary?: string;
}
export const listConfigRevisions = (agentId: string) => pc<ConfigRevision[]>(`/agents/${agentId}/config-revisions`);
export const rollbackConfigRevision = (agentId: string, revisionId: string) =>
  pc<Agent>(`/agents/${agentId}/config-revisions/${revisionId}/rollback`, { method: "POST" });

// ── Approvals ────────────────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected" | "revision_requested" | "resubmitted";

export interface Approval {
  id: string;
  type: string;
  status: ApprovalStatus;
  companyId: string;
  requestedByAgentId?: string;
  payload?: Record<string, unknown>;
  decisionNote?: string;
  createdAt: string;
}

export const listApprovals = (companyId: string, status?: ApprovalStatus) =>
  pc<Approval[]>(`/companies/${companyId}/approvals${status ? `?status=${status}` : ""}`);
export const approveApproval = (id: string, decisionNote?: string) =>
  pc<Approval>(`/approvals/${id}/approve`, { method: "POST", body: JSON.stringify({ decisionNote }) });
export const rejectApproval = (id: string, decisionNote?: string) =>
  pc<Approval>(`/approvals/${id}/reject`, { method: "POST", body: JSON.stringify({ decisionNote }) });

// ── Issues (units of work) ─────────────────────────────────────────────────

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";

export interface Issue {
  id: string;
  title: string;
  status: IssueStatus;
  priority?: string;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export const listIssues = (companyId: string, opts?: { assigneeAgentId?: string; status?: string }) => {
  const params = new URLSearchParams();
  if (opts?.assigneeAgentId) params.set("assigneeAgentId", opts.assigneeAgentId);
  if (opts?.status) params.set("status", opts.status);
  const qs = params.toString();
  return pc<Issue[]>(`/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
};

export const createIssue = (
  companyId: string,
  body: { title: string; description?: string; assigneeAgentId?: string },
) => pc<Issue>(`/companies/${companyId}/issues`, { method: "POST", body: JSON.stringify(body) });

// ── Activity (audit log) ─────────────────────────────────────────────────────

export interface ActivityRecord {
  id?: string;
  actorType?: string;
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown> | string;
  createdAt: string;
}

export const listActivity = (companyId: string, opts?: { agentId?: string; entityType?: string; entityId?: string }) => {
  const params = new URLSearchParams();
  if (opts?.agentId) params.set("agentId", opts.agentId);
  if (opts?.entityType) params.set("entityType", opts.entityType);
  if (opts?.entityId) params.set("entityId", opts.entityId);
  const qs = params.toString();
  return pc<ActivityRecord[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`);
};

// ── Adapter environment checks ────────────────────────────────────────────────

export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export const testAdapterEnvironment = (
  companyId: string,
  adapterType: string,
  adapterConfig: Record<string, unknown>,
) =>
  pc<AdapterEnvironmentTestResult>(`/companies/${companyId}/adapters/${adapterType}/test-environment`, {
    method: "POST",
    body: JSON.stringify({ adapterConfig }),
  });

// ── Costs ────────────────────────────────────────────────────────────────────

export interface CostSummary {
  spentCents: number;
  budgetCents: number;
  utilization: number;
}
export const costSummary = (companyId: string) => pc<CostSummary>(`/companies/${companyId}/costs/summary`);
export const costsByAgent = (companyId: string) =>
  pc<{ agentId: string; spentCents: number }[]>(`/companies/${companyId}/costs/by-agent`);
