// An UNMARKED POCO next to an unmarked helper: Customer is promoted to a
// model because ShopDb references it through DbSet<Customer>; OrderMapper is
// referenced by nothing and stays invisible.
namespace Svc.Models;

public class Customer
{
    public long Id { get; set; }
    public string? Email { get; set; }
}

public class OrderMapper
{
    public string Prefix { get; set; }
}
