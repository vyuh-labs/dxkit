---
paths:
  - "**/app/**/*.tsx"
  - "**/app/**/*.ts"
  - "**/pages/**/*.tsx"
  - "**/pages/**/*.ts"
  - "**/components/**/*.tsx"
  - "**/*.tsx"
---

# Next.js Rules

- Use App Router (`app/` directory) for new routes; follow the router the repo already uses
- Prefer Server Components by default; add `"use client"` only when needed
- Never expose secrets or sensitive data in client components
- Use TypeScript strict mode — no `any` types
- Validate API inputs with zod at route handlers
- Use Tailwind CSS for styling when the project is set up for it
- Run the project's build (e.g. `npm run build`, or `pnpm build` / `yarn build` to match your package manager) to catch type errors before committing
