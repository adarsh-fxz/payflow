"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ClaimInfo,
  DashboardStats,
  HealthResponse,
  Member,
  Notification,
  Organization,
  Paginated,
  PayrollRun,
  PayrollRunDetail,
  ReconciliationReport,
  Recipient,
  ReportsSummary,
  RecipientDashboard,
  RecipientListQuery,
  RunChainPlan,
  Schedule,
  SessionResponse,
} from "@/lib/api-types";
import { api, ApiClientError, OUTAGE_POLL_MS, outagePoll, shouldRetry } from "@/lib/client/api";

/** Accepts T[] or a wrapper ({ items } / { data } / named key) so list endpoints stay tolerant. */
export function asList<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === "object") {
    for (const v of Object.values(x as Record<string, unknown>)) if (Array.isArray(v)) return v as T[];
  }
  return [];
}

export const qk = {
  session: ["api", "session"] as const,
  health: ["api", "health"] as const,
  orgs: ["api", "orgs"] as const,
  org: (id: string) => ["api", "org", id] as const,
  members: (id: string) => ["api", "org", id, "members"] as const,
  recipients: (id: string, q?: RecipientListQuery) => ["api", "org", id, "recipients", q ?? {}] as const,
  runs: (id: string) => ["api", "org", id, "runs"] as const,
  run: (id: string, runId: string) => ["api", "org", id, "run", runId] as const,
  plan: (id: string, runId: string) => ["api", "org", id, "run", runId, "plan"] as const,
  dashboard: (id: string) => ["api", "org", id, "dashboard"] as const,
  reconciliation: (id: string) => ["api", "org", id, "reconciliation"] as const,
  reportsSummary: (id: string) => ["api", "org", id, "reports-summary"] as const,
  schedules: (id: string) => ["api", "org", id, "schedules"] as const,
  claim: (pid: string) => ["api", "claim", pid] as const,
  myPayments: ["api", "me", "payments"] as const,
  notifications: ["api", "notifications"] as const,
};

export function useSession() {
  return useQuery({
    queryKey: qk.session,
    queryFn: () => api<SessionResponse>("/api/auth/session"),
    staleTime: 60_000,
  });
}

export function useHealth() {
  // /api/health answers 503 with the same body when the RPC is down; read it either way.
  return useQuery({
    queryKey: qk.health,
    queryFn: async () => {
      const res = await fetch("/api/health", { headers: { Accept: "application/json" } });
      const body = (await res.json().catch(() => null)) as HealthResponse | null;
      if (body && typeof body === "object" && "rpc" in body) return body;
      if (res.status === 503) return { ok: false, rpc: "down" } as HealthResponse;
      throw new ApiClientError(res.status, "internal", `Health check failed (${res.status})`);
    },
    staleTime: 60_000,
    retry: 1,
    // While the RPC is down, keep checking slowly so "Can't reach Mezo" clears on its own.
    refetchInterval: (q) => (q.state.data?.rpc === "down" || q.state.status === "error" ? OUTAGE_POLL_MS : false),
  });
}

export function useOrgs(enabled = true) {
  return useQuery({
    queryKey: qk.orgs,
    queryFn: async () => asList<Organization>(await api<unknown>("/api/orgs")),
    enabled,
  });
}

/** Org by slug, resolved from the caller's org list, then refreshed by id. */
export function useOrgBySlug(slug: string, enabled = true) {
  const orgs = useOrgs(enabled);
  // Accepts the slug or the org UUID (notification links use the id).
  const fromList = orgs.data?.find((o) => o.slug === slug) ?? orgs.data?.find((o) => o.id === slug);
  const detail = useQuery({
    queryKey: qk.org(fromList?.id ?? "none"),
    queryFn: () => api<Organization>(`/api/orgs/${fromList!.id}`),
    enabled: enabled && Boolean(fromList),
    initialData: fromList,
  });
  return {
    org: detail.data ?? fromList,
    isLoading: orgs.isLoading,
    error: orgs.error ?? detail.error,
    notFound: orgs.isSuccess && !fromList,
    refetch: () => Promise.all([orgs.refetch(), detail.refetch()]),
  };
}

export function useMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: qk.members(orgId ?? ""),
    queryFn: async () => asList<Member>(await api<unknown>(`/api/orgs/${orgId}/members`)),
    enabled: Boolean(orgId),
  });
}

function qs(q: Record<string, unknown>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function useRecipients(orgId: string | undefined, q: RecipientListQuery = {}) {
  return useQuery({
    queryKey: qk.recipients(orgId ?? "", q),
    queryFn: async () => {
      const res = await api<Paginated<Recipient> | Recipient[]>(`/api/orgs/${orgId}/recipients${qs(q as Record<string, unknown>)}`);
      if (Array.isArray(res)) return { items: res, total: res.length, page: 1, pageSize: res.length } satisfies Paginated<Recipient>;
      return res;
    },
    enabled: Boolean(orgId),
    placeholderData: keepPreviousData,
  });
}

export function useRuns(orgId: string | undefined) {
  return useQuery({
    queryKey: qk.runs(orgId ?? ""),
    queryFn: async () => asList<PayrollRun>(await api<unknown>(`/api/orgs/${orgId}/runs`)),
    enabled: Boolean(orgId),
  });
}

export function useRun(orgId: string | undefined, runId: string) {
  return useQuery({
    queryKey: qk.run(orgId ?? "", runId),
    queryFn: () => api<PayrollRunDetail>(`/api/orgs/${orgId}/runs/${runId}`),
    enabled: Boolean(orgId),
    refetchInterval: (q) => outagePoll(q.state.error),
  });
}

export function useRunPlan(orgId: string | undefined, runId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.plan(orgId ?? "", runId),
    queryFn: () => api<RunChainPlan>(`/api/orgs/${orgId}/runs/${runId}/plan`),
    enabled: Boolean(orgId) && enabled,
    staleTime: 0,
  });
}

export function useDashboard(orgId: string | undefined) {
  return useQuery({
    queryKey: qk.dashboard(orgId ?? ""),
    queryFn: () => api<DashboardStats>(`/api/orgs/${orgId}/dashboard`),
    enabled: Boolean(orgId),
  });
}

export function useReconciliation(orgId: string | undefined) {
  return useQuery({
    queryKey: qk.reconciliation(orgId ?? ""),
    queryFn: () => api<ReconciliationReport>(`/api/orgs/${orgId}/reconciliation`),
    enabled: Boolean(orgId),
    refetchInterval: (q) => outagePoll(q.state.error),
  });
}

/** null when this server has no summary endpoint yet (404), so the page can say so instead of erroring. */
export function useReportsSummary(orgId: string | undefined) {
  return useQuery({
    queryKey: qk.reportsSummary(orgId ?? ""),
    queryFn: async () => {
      try {
        return await api<ReportsSummary>(`/api/orgs/${orgId}/reports/summary`);
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: Boolean(orgId),
    refetchInterval: (q) => outagePoll(q.state.error),
  });
}

export function useSchedules(orgId: string | undefined) {
  return useQuery({
    queryKey: qk.schedules(orgId ?? ""),
    queryFn: async () => asList<Schedule>(await api<unknown>(`/api/orgs/${orgId}/schedules`)),
    enabled: Boolean(orgId),
  });
}

export function useClaim(paymentId: string) {
  return useQuery({
    queryKey: qk.claim(paymentId),
    queryFn: () => api<ClaimInfo>(`/api/claims/${encodeURIComponent(paymentId)}`),
    retry: (n, err) => shouldRetry(n, err) && !(err instanceof Error && /not.?found/i.test(err.message)),
    refetchInterval: (q) => outagePoll(q.state.error),
  });
}

export function useMyPayments(enabled: boolean) {
  return useQuery({
    queryKey: qk.myPayments,
    queryFn: () => api<RecipientDashboard>("/api/me/payments"),
    enabled,
  });
}

export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: qk.notifications,
    queryFn: async () => asList<Notification>(await api<unknown>("/api/notifications")),
    enabled,
    refetchInterval: 60_000,
  });
}

/** Invalidate everything API-backed for an org (after a tx is recorded). */
export function useInvalidateOrg() {
  const qc = useQueryClient();
  return (orgId?: string) =>
    orgId
      ? Promise.all([
          qc.invalidateQueries({ queryKey: ["api", "org", orgId] }),
          qc.invalidateQueries({ queryKey: qk.notifications }),
        ])
      : qc.invalidateQueries({ queryKey: ["api"] });
}
