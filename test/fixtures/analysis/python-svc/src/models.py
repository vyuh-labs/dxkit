# A Django model + a pydantic model (extracted) next to a plain class
# (invisible - marker-based recognition, the fixture-matrix invariant).
from dataclasses import dataclass


class Article(models.Model):
    title = models.CharField(max_length=200)
    summary = models.TextField(null=True)


class ArticleDto(BaseModel):
    title: str
    summary: str | None = None


class ArticleIndexer:
    batch_size = 50
