/** In-app links used in notifications. Kept in one place so routes can change without hunting. */
export const links = {
  claim: (paymentId: string) => `/claim/${paymentId}`,
  myPayments: () => `/payments`,
  run: (orgId: string, runId: string) => `/app/${orgId}/runs/${runId}`,
  org: (orgId: string) => `/app/${orgId}`,
};
