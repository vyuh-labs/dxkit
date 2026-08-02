# The #223 shape: a member-PREFIXED test basename (pytest unique-basename
# constraint in a workspace) that the filename heuristic cannot associate
# with src/acme/util.py — only the import graph can.
from acme.util import answer


def test_answer() -> None:
    assert answer() == 42
