// Served surface: ASP.NET attribute routing with the [controller] token —
// the form that silently over-matched as /api/{var} before the
// enclosing-type substitution.
using Microsoft.AspNetCore.Mvc;

namespace Svc.Controllers;

[Route("api/[controller]")]
public class ReportsController : ControllerBase
{
    // Demo credential placeholder — the benign module must suppress it.
    private const string password = "password";

    [HttpGet("{id}")]
    public string Get(long id) => "";

    [HttpPost]
    public string Create() => "";
}
