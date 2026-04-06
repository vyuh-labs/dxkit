---
paths:
  - "frontend/**/*.ts"
  - "frontend/**/*.tsx"
  - "frontend/**/*.js"
  - "frontend/**/*.jsx"
---

# Next.js Rules

- Use App Router (`app/` directory), not Pages Router
- Prefer Server Components by default; add `"use client"` only when needed
- Never expose secrets or sensitive data in client components
- Use TypeScript strict mode — no `any` types
- Validate API inputs with zod at route handlers
- Use Tailwind CSS for styling (configured in project)
- Run `npm run build` in `frontend/` to catch type errors before committing
