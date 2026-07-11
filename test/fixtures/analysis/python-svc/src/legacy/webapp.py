"""Flask-shaped served surface: path-first decorator with a methods kwarg."""

from flask import Flask

flask_app = Flask(__name__)


@flask_app.route("/legacy", methods=["GET", "POST"])
def legacy():
    return ""
