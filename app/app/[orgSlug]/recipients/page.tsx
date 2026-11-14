import type { Metadata } from "next";
import { Suspense } from "react";
import { RecipientsView } from "@/components/recipients/recipients-view";

export const metadata: Metadata = { title: "Recipients" };

export default function RecipientsPage() {
  return (
    <Suspense>
      <RecipientsView />
    </Suspense>
  );
}
