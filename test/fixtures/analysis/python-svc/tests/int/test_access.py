"""Integration test importing the module under test via a src-layout
absolute import (`from authz.access import ...`). The import-graph resolver
must root this at `src/` and credit `src/authz/access.py` as tested.
"""

from authz.access import can_access


def test_admin_can_access():
    assert can_access("u1", "billing", ["admin"]) is True


def test_matching_role_grants_access():
    assert can_access("u2", "reports", ["reports"]) is True


def test_unrelated_role_denied():
    assert can_access("u3", "billing", ["reports"]) is False
