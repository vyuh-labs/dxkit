"""Consumed surface: requests/httpx calls binding every served form above.

The last call's URL is runtime-built — the coverage-honesty channel must
COUNT it as a dynamic call site, never silently drop it.
"""

import httpx
import requests


def fetch_item(item_id: int):
    return requests.get(f"/items/{item_id}")  # → FastAPI GET /items/{var}


def add_user():
    return httpx.post("/users")  # → FastAPI POST /users


def update_report(pk: int):
    return requests.put(f"/reports/{pk}/")  # → Django ANY /reports/{var}


def load_legacy():
    return requests.get("/legacy")  # → Flask GET /legacy


def opaque(url: str):
    return requests.get(url)  # dynamic: recognized, unverifiable, DISCLOSED
