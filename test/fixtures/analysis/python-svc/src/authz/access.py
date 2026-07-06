"""Access-control module under the `src/` layout (src/authz/access.py).

An integration test imports it as `from authz.access import can_access` —
an absolute import rooted at `src/`, not the project root. The import-graph
resolver must credit this file as tested rather than flag it as a gap.
"""


def can_access(user_id: str, resource: str, roles: list[str]) -> bool:
    if "admin" in roles:
        return True
    return resource in roles
