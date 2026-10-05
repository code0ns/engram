/** Shapes shared by the Access page tabs (People / Workspaces / Agent connections). */

export interface Repo {
  id: string;
  name: string;
  fullName?: string;
  url: string;
  branch: string;
  active: boolean;
  addedAt: string;
}

export interface ReposResponse {
  repos: Repo[];
  active: Repo | null;
  /** This session's current workspace — may differ per person now that access is scoped. */
  currentWorkspaceId: string | null;
}

export interface AccessGrant {
  email: string;
  workspaceIds: string[];
  isAdmin?: boolean;
}

export interface AccessResponse {
  authEnforced: boolean;
  me: { email: string; isAdmin: boolean };
  grants: AccessGrant[];
  repos: Pick<Repo, "id" | "name">[];
  allowedEmails: string[];
}

export interface TokenMeta {
  id: string;
  name: string;
  created: string;
  scope: "read" | "write";
  workspaceIds: string[];
}

/** GET /api/repos/[id]/treg — never contains the token itself. */
export interface TregSettings {
  hasToken: boolean;
  globalAvailable: boolean;
  enabled: boolean;
  orgId: string;
  perCallCapUsd: number;
  dailyCapUsd: number;
  spentTodayUsd: number;
  overrides: { orgId: boolean; perCallCapUsd: boolean; dailyCapUsd: boolean };
}
