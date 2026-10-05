import { redirect } from "next/navigation";

// Agent connections now live on the Access page; keep the old URL working.
export default function ConnectPage() {
  redirect("/access?tab=connections");
}
