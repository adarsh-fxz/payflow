export const SITE = {
  name: "PayFlow",
  tagline: "Payroll without borders. Payments powered by MUSD.",
  description: "Run payroll, distribute bounties, and pay contributors globally using MUSD on Mezo.",
  url: (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, ""),
} as const;
