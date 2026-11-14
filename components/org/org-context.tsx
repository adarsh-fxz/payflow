"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Organization } from "@/lib/api-types";

const Ctx = createContext<Organization | null>(null);

export function OrgProvider({ org, children }: { org: Organization; children: ReactNode }) {
  return <Ctx.Provider value={org}>{children}</Ctx.Provider>;
}

export function useOrg(): Organization {
  const o = useContext(Ctx);
  if (!o) throw new Error("useOrg must be used inside OrgProvider");
  return o;
}
