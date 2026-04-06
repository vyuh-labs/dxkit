---
paths:
  - "src/**/*.py"
  - "services/python/**/*.py"
  - "tests/**/*.py"
  - "**/*.py"
---

# Python Rules

- Use ruff for linting and formatting (not black, not flake8)
- Type hints required on all public functions
- Use Pydantic models for data validation at system boundaries
- Use `from __future__ import annotations` for forward references
- Prefer `pathlib.Path` over `os.path`
- No bare `except:` — catch specific exceptions
- Use app factory pattern for FastAPI/Flask applications
- Tests use pytest (not unittest) with fixtures for setup
- Imports: stdlib → third-party → local (ruff isort handles this)
