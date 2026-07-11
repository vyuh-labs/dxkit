// Consumed surface: a RestTemplate verb method, a WebClient builder chain,
// and an exchange(...) whose verb is an enum — recognized and DISCLOSED as
// dynamic, never silently dropped.
package com.example.client;

public class BackendClient {
  public Report fetch(long id) {
    return restTemplate.getForObject("/api/reports/{id}", Report.class, id);
  }

  public void submit(Report r) {
    webClient.post().uri("/api/reports").retrieve().toBodilessEntity().block();
  }

  public void opaque(String url) {
    restTemplate.exchange(url, HttpMethod.GET, null, Report.class);
  }
}
