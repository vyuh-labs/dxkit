// Consumed surface: Ktor client member verbs (a $id template segment must
// canonicalize to {var}), plus a runtime-built URL disclosed as dynamic.
package com.example

class BackendClient(private val client: HttpClient) {
    suspend fun item(id: Int): Item = client.get("/api/items/$id").body()

    suspend fun create(item: Item): Item = client.post("/api/items") {
        setBody(item)
    }.body()

    suspend fun opaque(url: String) {
        client.get(url)
    }
}
