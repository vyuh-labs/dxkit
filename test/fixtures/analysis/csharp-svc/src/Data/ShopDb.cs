// The EF Core container: the model marker lives HERE (DbSet<T> on a
// DbContext subclass), not on the entity classes it references.
using Microsoft.EntityFrameworkCore;

namespace Svc.Data;

public class ShopDb : DbContext
{
    public DbSet<Customer> Customers { get; set; }
}
