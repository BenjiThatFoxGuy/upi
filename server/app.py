import os

from unitypackage_inspector import create_app


app = create_app()


if __name__ == "__main__":
    host = os.getenv("UPI_HOST", "0.0.0.0")
    port = int(os.getenv("UPI_PORT") or os.getenv("PORT") or "8000")
    debug = os.getenv("UPI_DEV", "").strip().lower() in {"1", "true", "yes", "on"}
    app.run(host=host, port=port, debug=debug)
