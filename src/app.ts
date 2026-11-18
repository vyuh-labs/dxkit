export async function load() {
  return api.fetchJson('/articles/1');
}
export const c = () => api.fetchJson('/brand-new/call');
