// Served surface: an axum router — .nest prefixes ONLY its argument side
// (the chain-link /healthz sibling must not inherit /api), and .route mints
// method-agnostic ANY routes.
use axum::{routing::get, routing::post, Router};

pub fn app() -> Router {
    Router::new()
        .route("/healthz", get(health))
        .nest(
            "/api",
            Router::new()
                .route("/reports/{id}", get(get_report))
                .route("/reports", post(create_report)),
        )
}

async fn health() -> &'static str {
    "ok"
}

async fn get_report() -> &'static str {
    ""
}

async fn create_report() -> &'static str {
    ""
}
