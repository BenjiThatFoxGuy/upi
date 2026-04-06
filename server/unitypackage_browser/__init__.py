from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, jsonify, send_from_directory

from .routes import api


def create_app() -> Flask:
    frontend_dist = os.getenv("FRONTEND_DIST")
    static_folder = None
    if frontend_dist:
        dist_path = Path(frontend_dist)
        if dist_path.exists():
            static_folder = str(dist_path)

    app = Flask(__name__, static_folder=static_folder, static_url_path="/")
    app.register_blueprint(api, url_prefix="/api")

    allowed_origin = os.getenv("FRONTEND_ORIGIN", "*")

    @app.after_request
    def apply_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
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
