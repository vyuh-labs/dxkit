// A plain access-control module — the kind of source file an integration
// test exercises by importing it via the `@/` path alias rather than a deep
// relative path. No HTTP calls (keeps the flow fixture's call count intact).

export interface AccessRequest {
  userId: string;
  resource: string;
}

export function canAccess(req: AccessRequest, roles: string[]): boolean {
  if (roles.includes('admin')) return true;
  return roles.includes(req.resource);
}
