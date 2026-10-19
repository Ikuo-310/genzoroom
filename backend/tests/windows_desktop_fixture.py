"""Generated loopback-only image fixture for the opt-in real WebView2 smoke test."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
import secrets
from threading import Thread
from uuid import uuid4

from PIL import Image


def start():
    api_key = secrets.token_urlsafe(32)
    output = BytesIO()
    with Image.new("RGB", (2, 2), (90, 120, 150)) as image:
        image.save(output, format="JPEG")
    jpeg = output.getvalue()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path == "/api/users/me":
                identity = server.users.get(self.headers.get("x-api-key"))
                authenticated = identity is not None
                body = json.dumps({"id": identity} if authenticated else {}).encode()
                self.send_response(200 if authenticated else 401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            image_request = self.path.startswith("/api/assets/") and "/thumbnail" in self.path
            if image_request and self.headers.get("x-api-key") in server.users:
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
    server.user_id = str(uuid4())
    server.users = {api_key: server.user_id}
    Thread(target=server.serve_forever, daemon=True).start()
    os.environ["IMMICH_URL"] = f"http://127.0.0.1:{server.server_port}"
    os.environ["IMMICH_API_KEY"] = api_key
    return server
