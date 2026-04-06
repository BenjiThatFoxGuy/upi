from __future__ import annotations

from pathlib import Path

from flask import Flask, jsonify, send_from_directory

from .config import load_settings
from .routes import api


def create_app() -> Flask:
    settings = load_settings()
    static_folder = settings.static_folder
    app = Flask(__name__, static_folder=static_folder, static_url_path="/")
    app.config["UI_THEME"] = settings.theme
    app.config["UI_THEME_ENFORCED"] = settings.theme_enforced
    app.config["IDENTITY_CATALOG_URL"] = settings.identity_catalog_url
    app.config["IDENTITY_LOOKUP_ENABLED"] = settings.identity_lookup_enabled
    app.config["IDENTITY_LOOKUP_TIMEOUT_SECONDS"] = settings.identity_lookup_timeout_seconds
    app.register_blueprint(api, url_prefix="/api")

    @app.after_request
    def apply_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = settings.allowed_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
        return response

    @app.get("/health")
    def healthcheck():
        return jsonify({"status": "ok"})

    if static_folder:
        @app.get("/")
        def spa_index():
            return send_from_directory(app.static_folder, "index.html")

        @app.get("/<path:path>")
        def spa_assets(path: str):
            asset_path = Path(app.static_folder, path)
            if asset_path.exists():
                return send_from_directory(app.static_folder, path)
            return send_from_directory(app.static_folder, "index.html")

    return app
