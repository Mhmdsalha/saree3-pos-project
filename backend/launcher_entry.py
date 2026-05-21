from __future__ import annotations

import os

import uvicorn
from main import app
from services.local_ssl_service import ensure_local_ssl


def main() -> None:
    host = os.getenv("HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("PORT", "8000"))
    ssl_state = ensure_local_ssl(os.getenv("FLOWPOS_APP_DATA_DIR"))
    uvicorn.run(
        app,
        host=host,
        port=port,
        reload=False,
        access_log=True,
        ssl_certfile=str(ssl_state.server_cert_path),
        ssl_keyfile=str(ssl_state.server_key_path),
    )


if __name__ == "__main__":
    main()
