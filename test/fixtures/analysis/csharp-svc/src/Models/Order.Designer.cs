// The codegen half of the partial Order entity — a field here is the SAME
// model as Order.cs's, never a duplicate entity or a remove+add drift.
namespace Svc.Models;

public partial class Order
{
    public string? DesignerState { get; set; }
}
