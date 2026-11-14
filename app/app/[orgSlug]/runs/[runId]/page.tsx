import type { Metadata } from "next";
import { Suspense } from "react";
import { RunDetailView } from "@/components/runs/detail/run-detail";

export const metadata: Metadata = { title: "Payroll run" };

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense>
      <RunDetailView runId={runId} />
    </Suspense>
  );
}
