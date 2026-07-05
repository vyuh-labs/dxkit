export function submit() {
  return fetch(`${getClientSideURL()}/api/form-submissions`, { method: "POST" });
}
export function me() {
  return fetch(`${getClientSideURL()}/api/users/me`);
}
