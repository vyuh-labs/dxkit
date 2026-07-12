// Consumed surface: HttpClient verb methods (an interpolated URL and a plain
// one), plus a runtime-built URL — recognized and DISCLOSED as dynamic,
// never silently dropped.
namespace Svc.Clients;

public class BackendClient
{
    private readonly HttpClient client;

    public async Task<string?> Fetch(long id)
    {
        return await client.GetFromJsonAsync<string>($"/api/reports/{id}");
    }

    public async Task Submit(HttpContent body)
    {
        await client.PostAsync("/api/reports", body);
    }

    public async Task Opaque()
    {
        await client.GetAsync(BuildUrl());
    }

    private string BuildUrl() => "";
}
