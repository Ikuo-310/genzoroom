"""Generated loopback-only image fixture for the opt-in real WebView2 smoke test."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from threading import Thread

from PIL import Image


def start():
    output = BytesIO()
    with Image.new("RGB", (2, 2), (90, 120, 150)) as image:
        image.save(output, format="JPEG")
    jpeg = output.getvalue()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            image_request = self.path.startswith("/api/assets/") and "/thumbnail" in self.path
            if image_request and self.headers.get("x-api-key") == "native-smoke-fixture":
                body, media_type = jpeg, "image/jpeg"
            else:
                value = {"res": "pong"} if self.path == "/api/server/ping" else []
                body, media_type = json.dumps(value).encode(), "application/json"
            self.send_response(200)
            self.send_header("Content-Type", media_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    os.environ["IMMICH_URL"] = f"http://127.0.0.1:{server.server_port}"
    os.environ["IMMICH_API_KEY"] = "native-smoke-fixture"
    return server
