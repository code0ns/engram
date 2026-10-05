import { redirect } from "next/navigation";

// Workspaces now live on the Access page; keep the old URL working.
export default function WorkspacesPage() {
  redirect("/access?tab=workspaces");
}
