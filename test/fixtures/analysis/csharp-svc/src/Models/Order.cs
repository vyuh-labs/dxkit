// A [Table]-marked PARTIAL entity (extracted; string? is real grammar-level
// optionality) — its codegen half lives in Order.Designer.cs and the two
// declarations must assemble into ONE entity.
using System.ComponentModel.DataAnnotations.Schema;

namespace Svc.Models;

[Table("orders")]
public partial class Order
{
    public long Id { get; set; }
    public string Title { get; set; }
    public string? Note { get; set; }
}
