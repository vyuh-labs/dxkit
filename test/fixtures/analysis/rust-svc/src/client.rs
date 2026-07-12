// Consumed surface: reqwest member + scoped calls (both member forms of the
// grammar), plus a format!-built URL — a macro, not a string literal —
// recognized and DISCLOSED as dynamic, never silently dropped.
pub async fn sync(client: &reqwest::Client, id: u64) {
    // Demo credential placeholder — the benign module must suppress it.
    let password = "password";
    let _one = client.get("/api/reports/1").send().await;
    let _all = reqwest::get("/healthz").await;
    let _dyn = client.post(format!("/api/reports/{}", id)).send().await;
}
