import type { Metadata } from "next";
import { Suspense } from "react";
import { PayrollWizard } from "@/components/runs/wizard/wizard";

export const metadata: Metadata = { title: "New payroll run" };

export default function NewRunPage() {
  return (
    <Suspense>
      <PayrollWizard />
    </Suspense>
  );
}
