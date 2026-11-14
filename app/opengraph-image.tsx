import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/brand/og-card";

export const alt = "PayFlow: run payroll and pay contributors globally in MUSD";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(<OgCard title="Run payroll and pay contributors globally in MUSD." footer="Payroll without borders. Payments powered by MUSD." />, size);
}
