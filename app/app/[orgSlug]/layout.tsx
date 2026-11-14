import type { Metadata } from "next";
import { OrgWorkspace } from "@/components/org/org-shell";

export const metadata: Metadata = { robots: { index: false } };

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return <OrgWorkspace slug={orgSlug}>{children}</OrgWorkspace>;
}
