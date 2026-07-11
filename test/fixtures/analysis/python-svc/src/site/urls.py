"""Django-shaped served surface: verb-less path() declarations (ANY routes)."""

from django.urls import include, path

from . import views

urlpatterns = [
    path("reports/<int:pk>/", views.report_detail),
    # A mount is a PREFIX, not a served route — must not mint one.
    path("admin/", include("site.admin_urls")),
]
