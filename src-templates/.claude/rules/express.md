---
paths:
  - "**/routes/**/*"
  - "**/middleware/**/*"
  - "**/controllers/**/*"
  - "**/*.router.ts"
  - "**/*.router.js"
---

## Express Conventions

### Routes
- Use `express.Router()` for modular route definitions
- Group routes by domain: `/api/users`, `/api/orders`
- Use middleware for auth, validation, error handling — not route handlers

### Middleware
- Error-handling middleware has 4 params: `(err, req, res, next)`
- Always call `next()` in non-terminal middleware
- Order matters: auth before route handlers, error handler last

### Error Handling
- Use `next(error)` to pass errors to error-handling middleware
- Never swallow errors silently in catch blocks
- Return appropriate HTTP status codes (400 for validation, 401 for auth, 500 for server)

### Request Handling
- Validate request body/params before processing
- Use `async/await` with try/catch (or express-async-errors)
- Always send a response — never leave requests hanging
