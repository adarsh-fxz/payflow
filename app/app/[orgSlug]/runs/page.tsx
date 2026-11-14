import type { Metadata } from "next";
import { RunsList } from "@/components/runs/runs-list";

export const metadata: Metadata = { title: "Payroll runs" };

export default function RunsPage() {
  return <RunsList />;
}
