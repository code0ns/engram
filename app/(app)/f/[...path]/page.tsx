"use client";

import { useParams } from "next/navigation";
import { FolderBrowser } from "@/components/folder-browser";

export default function FolderPage() {
  const params = useParams();
  const raw = params.path;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const path = arr.map((s) => decodeURIComponent(s)).join("/");
  if (!path) return null;
  return <FolderBrowser folderPath={path} />;
}
