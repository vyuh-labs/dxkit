---
paths:
  - "**/*.controller.ts"
  - "**/*.model.ts"
  - "**/*.repository.ts"
  - "**/*.datasource.ts"
  - "**/*.service.ts"
  - "**/controllers/**/*"
  - "**/models/**/*"
  - "**/repositories/**/*"
---

## LoopBack 4 Conventions

### Controllers
- Use decorators: `@get`, `@post`, `@put`, `@patch`, `@del` for route definitions
- Use `@param` for path/query parameters, `@requestBody` for body
- Controllers should delegate business logic to services, not implement it directly
- Use `@response` decorator for OpenAPI documentation

### Models
- Extend `Entity` for database-backed models
- Use `@model()` and `@property()` decorators
- Define relationships with `@hasMany`, `@belongsTo`, `@hasOne`
- Set `id: true` on the primary key property

### Repositories
- Extend `DefaultCrudRepository` for standard CRUD
- Use `@repository` decorator for dependency injection
- Custom queries should be methods on the repository, not the controller

### Dependency Injection
- Use constructor injection: `@inject('key')` or `@repository(ModelRepository)`
- Bind services in `application.ts`
- Use `@service` decorator for service injection

### Naming
- Controllers: `*.controller.ts` with class `*Controller`
- Models: `*.model.ts` with class `*` (PascalCase)
- Repositories: `*.repository.ts` with class `*Repository`
- Datasources: `*.datasource.ts`
