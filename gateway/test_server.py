import base64
import http.server
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from server import AccessStore, Gateway, Provider, PROMPTS, normalize_latex, normalize_output


def png():
    return "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + struct.pack(">II", 8, 8) + bytes(20)).decode()


class Upstream(http.server.BaseHTTPRequestHandler):
    requests = []
    finish_reason = "stop"
    status = 200

    def log_message(self, *args):
        pass

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append({"path": self.path, "authorization": self.headers.get("Authorization"), "body": value})
        body = json.dumps({"choices": [{"finish_reason": self.server.finish_reason, "message": {"content": getattr(self.server, "content", "\\frac{X+x}{2}"), "reasoning_content": "must remain private"}}]}).encode()
        self.send_response(self.server.status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = AccessStore(Path(self.temporary.name) / "gateway")
        self.alice = self.store.create_account("Alice")
        self.bob = self.store.create_account("Bob")
        self.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        self.upstream.requests = []
        self.upstream.finish_reason = "stop"
        self.upstream.status = 200
        self.environment = {"ANNOTATION_LLM_BASE_URL": "http://127.0.0.1:" + str(self.upstream.server_port) + "/v1", "ANNOTATION_LLM_API_KEY": "fixture-shared-provider-key", "ANNOTATION_LLM_MODEL": "fixture-vision"}
        self.provider = Provider(self.environment)
        self.gateway = Gateway(("127.0.0.1", 0), self.store, self.provider)
        for server in (self.upstream, self.gateway):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in (self.gateway, self.upstream):
            server.shutdown()
            server.server_close()
        self.temporary.cleanup()

    def request(self, route, value=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request("http://127.0.0.1:" + str(self.gateway.server_port) + route,
                                         data=json.dumps(value).encode() if value is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def login(self, account=None):
        status, value = self.request("/login", {"inviteCode": (account or self.alice)["inviteCode"]})
        self.assertEqual(status, 200)
        return value["token"]

    def test_invites_are_private_and_session_survives_store_restart(self):
        token = self.login()
        restored = AccessStore(self.store.directory)
        self.assertEqual(restored.session(token)["accountId"], self.alice["accountId"])
        for file in self.store.directory.glob("*"):
            if file.is_file():
                raw = file.read_bytes()
                self.assertNotIn(token.encode(), raw)
                self.assertNotIn(self.alice["inviteCode"].encode(), raw)

    def test_multiple_devices_and_individual_revocation(self):
        first, second, other = self.login(), self.login(), self.login(self.bob)
        self.assertNotEqual(first, second)
        self.assertEqual(self.request("/session", token=first)[0], 200)
        self.store.revoke(self.alice["accountId"])
        self.assertEqual(self.request("/session", token=first)[0], 401)
        self.assertEqual(self.request("/session", token=second)[0], 401)
        self.assertEqual(self.request("/session", token=other)[0], 200)
        self.assertEqual(self.request("/login", {"inviteCode": self.alice["inviteCode"]})[0], 401)

    def test_invalid_invitation_and_anonymous_recognition(self):
        self.assertEqual(self.request("/login", {"inviteCode": "incorrect"})[0], 401)
        self.assertEqual(self.request("/recognize", {"png": png()})[0], 401)
        self.assertEqual(self.upstream.requests, [])

    def test_only_provider_receives_shared_key_and_only_formula_is_sent(self):
        token = self.login()
        status, value = self.request("/recognize", {"png": png()}, token)
        self.assertEqual(status, 200)
        self.assertEqual(value, {"latex": "\\frac{X+x}{2}", "model": "fixture-vision"})
        upstream = self.upstream.requests[0]
        self.assertEqual(upstream["authorization"], "Bearer fixture-shared-provider-key")
        self.assertEqual(upstream["path"], "/v1/chat/completions")
        self.assertEqual(upstream["body"]["messages"][1]["content"][1]["image_url"]["url"], png())
        self.assertNotIn("\\frac{X+x}{2}", json.dumps(upstream["body"]))
        self.assertNotIn("fixture-shared-provider-key", json.dumps(value))
        self.assertNotIn(token, json.dumps(value))

    def test_unconfigured_provider_has_no_fallback(self):
        self.gateway.provider = Provider({})
        token = self.login()
        self.assertEqual(self.request("/session", token=token)[1]["providerReady"], False)
        self.assertEqual(self.request("/recognize", {"png": png()}, token)[0], 503)
        self.assertEqual(self.upstream.requests, [])

    def test_output_format_selects_server_prompt_and_canonical_markdown(self):
        token = self.login()
        status, value = self.request("/recognize", {"png": png(), "outputFormat": "markdown"}, token)
        self.assertEqual(status, 200)
        self.assertEqual(value["latex"], "$$\n\\frac{X+x}{2}\n$$")
        self.assertEqual(self.upstream.requests[-1]["body"]["messages"][0]["content"], PROMPTS["markdown"])
        self.upstream.content = 'flowchart LR\n a["A"] --> b["B"]'
        status, value = self.request("/recognize", {"png": png(), "outputFormat": "mermaid"}, token)
        self.assertEqual(status, 200)
        self.assertEqual(value["latex"], '```mermaid\nflowchart LR\n a["A"] --> b["B"]\n```')
        self.assertEqual(self.upstream.requests[-1]["body"]["messages"][0]["content"], PROMPTS["mermaid"])
        calls = len(self.upstream.requests)
        for mode in ("ma", "arbitrary prompt", [], None):
            self.assertEqual(self.request("/recognize", {"png": png(), "outputFormat": mode}, token)[0], 400)
        self.assertEqual(len(self.upstream.requests), calls)
        with self.assertRaises(ValueError):
            normalize_output("UNREADABLE", "mermaid")

    def test_auto_transcribes_each_content_type_and_wraps_formula_with_single_dollars(self):
        token = self.login()
        for kind, content, expected in (
                ("text", "Keep the original words.", "Keep the original words."),
                ("markdown", "# Heading\n- Item", "# Heading\n- Item"),
                ("formula", "\\frac{X+x}{2}", "$\\frac{X+x}{2}$"),
                ("mermaid", 'flowchart LR\n a["A"] --> b["B"]', '```mermaid\nflowchart LR\n a["A"] --> b["B"]\n```')):
            self.upstream.content = json.dumps({"type": kind, "content": content})
            status, value = self.request("/recognize", {"png": png(), "outputFormat": "auto"}, token)
            self.assertEqual(status, 200)
            self.assertEqual(value["detectedType"], kind)
            self.assertEqual(value["latex"], expected)
        self.upstream.content = json.dumps({"type": "arbitrary", "content": "bad"})
        self.assertEqual(self.request("/recognize", {"png": png(), "outputFormat": "auto"}, token)[0], 400)

    def test_invalid_images_do_not_consume_provider_calls(self):
        token = self.login()
        for value in ("https://external.example/image.png", "data:image/png;base64,invalid", None):
            self.assertEqual(self.request("/recognize", {"png": value}, token)[0], 400)
        self.assertEqual(self.upstream.requests, [])

    def test_daily_limits_are_shared_and_durable(self):
        self.gateway.daily_global = 1
        token = self.login()
        self.assertEqual(self.request("/recognize", {"png": png()}, token)[0], 200)
        self.gateway.store = AccessStore(self.store.directory)
        other = self.login(self.bob)
        self.assertEqual(self.request("/recognize", {"png": png()}, other)[0], 429)
        self.assertEqual(len(self.upstream.requests), 1)

    def test_rate_limit_stops_further_provider_calls(self):
        token = self.login()
        for _ in range(12):
            self.assertEqual(self.request("/recognize", {"png": png()}, token)[0], 200)
        self.assertEqual(self.request("/recognize", {"png": png()}, token)[0], 429)
        self.assertEqual(len(self.upstream.requests), 12)

    def test_provider_errors_and_partial_results_are_not_success(self):
        token = self.login()
        self.upstream.finish_reason = "length"
        self.assertNotEqual(self.request("/recognize", {"png": png()}, token)[0], 200)
        self.upstream.status = 401
        status, value = self.request("/recognize", {"png": png()}, token)
        self.assertEqual(status, 502)
        self.assertNotIn("fixture-shared-provider-key", json.dumps(value))

    def test_provider_configuration_and_math_grouping(self):
        with self.assertRaises(ValueError):
            Provider({**self.environment, "ANNOTATION_LLM_BASE_URL": "http://external.example/v1"})
        with self.assertRaises(ValueError):
            Provider({**self.environment, "ANNOTATION_LLM_EXTRA_JSON": '{"messages": []}'})
        self.assertEqual(normalize_latex("```latex\n\\frac{X+x}{2}\n```"), "\\frac{X+x}{2}")


if __name__ == "__main__":
    unittest.main()
