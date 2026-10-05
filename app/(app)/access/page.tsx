"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PeopleTab } from "@/components/access/people-tab";
import { WorkspacesTab } from "@/components/access/workspaces-tab";
import { ConnectionsTab } from "@/components/access/connections-tab";

const TABS = [
  { id: "people", label: "People" },
  { id: "workspaces", label: "Workspaces" },
  { id: "connections", label: "Agent connections" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** The active tab lives in the URL (?tab=) so it survives reloads and old /workspaces and /connect links. */
function AccessTabs() {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : "people";

  return (
    <Tabs value={tab} onValueChange={(v) => router.replace(`/access?tab=${v}`, { scroll: false })} className="mt-6">
      <TabsList>
        {TABS.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="people">
        <PeopleTab />
      </TabsContent>
      <TabsContent value="workspaces">
        <WorkspacesTab />
      </TabsContent>
      <TabsContent value="connections">
        <ConnectionsTab />
      </TabsContent>
    </Tabs>
  );
}

export default function AccessPage() {
  return (
    <div className="scrollbar-none h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Access</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Who can reach which vault, and how: people, the workspaces themselves, and the agents that connect to them.
        </p>
        <Suspense fallback={null}>
          <AccessTabs />
        </Suspense>
      </div>
    </div>
  );
}
