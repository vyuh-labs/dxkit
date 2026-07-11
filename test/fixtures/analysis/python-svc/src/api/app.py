"""FastAPI-shaped served surface: member verb decorators."""

from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter()


@app.get("/items/{item_id}")
def read_item(item_id: int):
    return {"id": item_id}


@router.post("/users")
def create_user():
    return {"ok": True}
