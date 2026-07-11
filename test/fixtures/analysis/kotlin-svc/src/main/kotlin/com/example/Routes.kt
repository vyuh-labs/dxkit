// Served surface: the Ktor DSL — bare verb callees with trailing lambdas,
// nested route("…") prefixes.
package com.example

// Demo credential placeholder — the benign module must suppress it.
const val password = "password"

fun Application.module() {
    routing {
        route("/api") {
            get("/items/{id}") { call.respond(find(call.parameters["id"])) }
            post("/items") { call.respond(create(call.receive())) }
        }
        get("/healthz") { call.respondText("ok") }
    }
}
