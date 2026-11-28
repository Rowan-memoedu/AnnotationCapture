import base64
import http.server
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest.mock import call, patch
import urllib.error
import urllib.request

from server import AccessStore, Gateway, Provider, PROMPTS, normalize_latex, normalize_output, blank_rectangles, calculator_notation


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

    def test_handwritten_answers_send_the_actual_layout_and_only_return_empty_fields(self):
        token = self.login()
        context = {"question": "y = [[s1]], x = [[s2]], units [[s3]]",
                   "fields": [{"id": "s1", "format": "latex", "current": ""},
                              {"id": "s2", "format": "latex", "current": "0"},
                              {"id": "s3", "format": "text", "current": ""}]}
        payload = {"context": context, "png": png()}
        result = {"status": "ready", "answers": [{"id": "s3", "value": "cm"}, {"id": "s1", "value": r"\frac{1}{2}"}]}
        self.upstream.content = json.dumps(result)
        self.assertEqual(self.request("/answer-fields", payload, token), (200, result))
        body = self.upstream.requests[-1]["body"]
        self.assertEqual(body["response_format"], {"type": "json_object"})
        text, image = body["messages"][1]["content"]
        self.assertEqual(json.loads(text["text"]), context)
        self.assertEqual(image["image_url"]["url"], payload["png"])
        for ids in (["s1"], ["s1", "s1"], ["s1", "s2"], ["s1", "surprise"]):
            self.upstream.content = json.dumps({"status":"ready", "answers":[{"id":i, "value":"1"} for i in ids]})
            self.assertNotEqual(self.request("/answer-fields", payload, token)[0], 200)
        clarify = {"status":"clarify", "message":"请圈出两个坐标。"}
        self.upstream.content = json.dumps(clarify)
        self.assertEqual(self.request("/answer-fields", payload, token), (200, clarify))
        self.assertIn(self.request("/answer-fields", payload)[0], (401, 403))

    def test_answer_fields_validate_question_shape_before_model_call(self):
        token = self.login()
        for q, f in (("Choose [[s1]]", {"id":"s1","format":"choice","options":["a","a"],"current":""}),
                     ("y = [[s2]]", {"id":"s1","format":"latex","current":""}),
                     ("x = [[s1]]", {"id":"s1","format":"latex","current":"0"})):
            self.assertEqual(self.request("/answer-fields", {"png":png(),"context":{"question":q,"fields":[f]}}, token)[0], 400)
        self.assertFalse(self.upstream.requests)
        self.upstream.content = json.dumps({"status":"ready","answers":[{"id":"s1","value":"unknown"}]})
        field = {"id":"s1","format":"choice","current":"","options":["a","b"]}
        self.assertNotEqual(self.request("/answer-fields", {"png":png(),"context":{"question":"[[s1]]","fields":[field]}}, token)[0], 200)

    def test_shared_formula_transcribes_with_one_prompt_and_preserves_case(self):
        token = self.login()
        self.upstream.content = r"\frac{X+x}{2}"
        payload = {"png": png(), "formulaMode": "shared"}
        for output_format, latex in (
            ("latex", r"\frac{X+x}{2}"),
            ("inlineMath", r"$\frac{X+x}{2}$"),
            ("calculator", "((X+x)/(2))"),
        ):
            status, result = self.request("/recognize", {**payload, "outputFormat": output_format}, token)
            self.assertEqual((status, result["latex"]), (200, latex))
        self.assertEqual(len(self.upstream.requests), 3)
        first, *other = [request["body"]["messages"] for request in self.upstream.requests]
        self.assertTrue(all(messages == first for messages in other))

    def test_shared_calculator_notation_keeps_grouping(self):
        for latex, expected in (
            (r"2x_2+\sqrt{(x+1)^2}", "2*x_2+sqrt((x+1)^(2))"),
            (r"\frac{2}{\frac{3}{4}}", "((2)/(((3)/(4))))"),
            (r"\log_{2}(8)+5\%", "log_2(8)+5%"),
            (r"\operatorname{mod}(17,5)", "mod(17,5)"),
            (r"17 \bmod 5", "17 mod 5"),
            (r"\alpha x\leq X", "α*x<=X"),
        ):
            with self.subTest(latex=latex):
                self.assertEqual(calculator_notation(latex), expected)
        for latex in (r"\sqrt{}", r"\frac{1}", r"\int_0^1 x dx", "X+}"):
            with self.subTest(latex=latex):
                with self.assertRaises(ValueError):
                    calculator_notation(latex)

    def test_matrix_notation_preserves_rows_columns_and_cell_structure(self):
        cases = {
            r"\begin{pmatrix}1\\-2\\3\end{pmatrix}-\begin{bmatrix}4\\5\\6\end{bmatrix}":
                "[[1],[-2],[3]]-[[4],[5],[6]]",
            r"\left[\begin{array}{cr}\frac{1}{2}&2\\3&-4\\\end{array}\right]":
                "([[((1)/(2)),2],[3,-4]])",
            r"2\begin{smallmatrix}1&x_2\cr 0&3\end{smallmatrix}": "2*[[1,x_2],[0,3]]",
              r"\begin{aligned}\begin{pmatrix}-2\\0\end{pmatrix}&+0,95\begin{pmatrix}0,3\\0{,}1\end{pmatrix}\\&-\frac{1}{20}\begin{pmatrix}1\\3\end{pmatrix}\cdot2(-2)\end{aligned}":
                  "[[-2],[0]]+0.95*[[0.3],[0.1]]-((1)/(20))*[[1],[3]]*2*(-2)",
              r"0{,}75\cdot\begin{bmatrix}1,25\\-0,4\end{bmatrix}": "0.75*[[1.25],[-0.4]]",
              r"\operatorname{mod}(17,5)": "mod(17,5)",
              r"\begin{pmatrix}2x\\3x^2-2x\end{pmatrix}-y\begin{pmatrix}5\frac{x}{y}\\6x\end{pmatrix}":
                  "[[2*x],[3*x^(2)-2*x]]-y*[[5*((x)/(y))],[6*x]]",
        }
        for latex, expected in cases.items():
            with self.subTest(latex=latex):
                self.assertEqual(calculator_notation(latex), expected)
        for latex in (
            r"\begin{matrix}1&2\\3\end{matrix}",
            r"\begin{matrix}1&\\2&3\end{matrix}",
            r"\begin{matrix}1\end{bmatrix}",
              r"\begin{matrix}1,2,3\\4\end{matrix}",
            r"\begin{vmatrix}1&2\\3&4\end{vmatrix}",
              r"\begin{aligned}1+2\\3+4\end{aligned}",
              r"\begin{gathered}1+2\\x=4\end{gathered}",
        ):
            with self.subTest(latex=latex), self.assertRaises(ValueError):
                calculator_notation(latex)

    def test_shared_calculator_distinguishes_unreadable_from_unsupported(self):
        provider = self.gateway.provider
        with patch.object(provider, "_compat_completion", return_value=r"\int_0^1 x\,dx") as upstream:
            result = provider.recognize_formula(png(), "calculator")
            self.assertEqual(result["latex"], r"\int_0^1 x\,dx")
            self.assertIs(result["calculatorSupported"], False)
            upstream.assert_called_once()
        with patch.object(provider, "_compat_completion", return_value=r"\text{UNREADABLE}"):
            with self.assertRaises(ValueError):
                provider.recognize_formula(png(), "calculator")

    def test_deepseek_formula_uses_fast_mode_then_configured_fallback(self):
        provider = Provider({**self.environment, "ANNOTATION_LLM_BASE_URL": "https://api.deepseek.com",
                             "ANNOTATION_LLM_MODEL": "deepseek-flash",
                             "ANNOTATION_LLM_EXTRA_JSON": '{"thinking":{"type":"enabled"},"reasoning_effort":"low"}'})
        image = png()
        expected = {"latex": "3+7", "model": "deepseek-flash"}
        with patch.object(provider, "_recognize", side_effect=[ValueError("UNREADABLE"), expected, expected, expected, expected]) as transcribe:
            self.assertEqual(provider.recognize(image, "calculator"), expected)
            self.assertEqual(provider.recognize(image, "latex"), expected)
            self.assertEqual(provider.recognize(image, "inlineMath"), expected)
            self.assertEqual(provider.recognize(image, "markdown"), expected)
        self.assertEqual(transcribe.call_args_list, [
            call(image, "calculator", {"thinking": {"type": "disabled"}}, timeout=10),
            call(image, "calculator", provider.extra, timeout=14),
            call(image, "latex", {"thinking": {"type": "disabled"}}, timeout=10),
            call(image, "inlineMath", {"thinking": {"type": "disabled"}}, timeout=10),
            call(image, "markdown", {"thinking": {"type": "disabled"}}, timeout=10),
        ])
        with patch.object(provider, "_recognize", side_effect=TimeoutError) as transcribe:
            with self.assertRaises(TimeoutError):
                provider.recognize(image, "calculator")
            transcribe.assert_called_once()

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

    def test_explicit_provider_shares_session_and_updates_both_image_routes(self):
        self.gateway.ocr_providers["deepseek"] = self.provider
        token = self.login()
        status, session = self.request("/session", token=token)
        self.assertEqual((status, session["ocrProviders"]), (200, ["deepseek"]))
        self.assertEqual(self.request("/recognize", {"png": png(), "provider": "openai"}, token)[0], 503)
        self.assertEqual(self.request("/recognize", {"png": png(), "provider": "other"}, token)[0], 400)
        self.assertEqual(self.upstream.requests, [])
        status, recognized = self.request("/recognize", {"png": png(), "provider": "deepseek"}, token)
        self.assertEqual((status, recognized["provider"]), (200, "deepseek"))
        self.upstream.content = '{"regions":[],"panels":[],"blocked":[],"taskbar":[],"chrome":[]}'
        status, layout = self.request("/whitespace", {"png": png(), "provider": "deepseek"}, token)
        self.assertEqual((status, layout["provider"]), (200, "deepseek"))
        self.assertEqual(len(self.upstream.requests), 2)

    def test_calculator_transcribes_without_evaluating(self):
        token = self.login()
        self.upstream.content = "mod(17,5)+sqrt(4)"
        status, actual = self.request("/recognize", {"png": png(), "outputFormat": "calculator"}, token)
        self.assertEqual(status, 200)
        self.assertEqual(actual["latex"], self.upstream.content)
        prompt = self.upstream.requests[-1]["body"]["messages"][0]["content"]
        self.assertIn("Do not solve", prompt)
        self.assertIn("mod(a,b)", prompt)
        for content in ("UNREADABLE", "1\n2", "\\frac{3}{2}"):
            self.upstream.content = content
            self.assertEqual(self.request("/recognize", {"png": png(), "outputFormat": "calculator"}, token)[0], 400)

    def test_whitespace_is_authenticated_and_preferences_reach_the_prompt(self):
        self.assertEqual(self.request("/whitespace", {"png": png()})[0], 401)
        self.gateway.provider.extra = {"thinking": {"type": "enabled"}, "reasoning_effort": "low"}
        self.gateway.provider.model = "deepseek-flash"
        token = self.login()
        self.upstream.content = json.dumps({"panels": [[250, 200, 750, 800]], "blocked": [], "taskbar": [[0,950,1000,1000]], "chrome": [[0,0,1000,50]]})
        for allowed in (True, False):
            status, value = self.request("/whitespace", {"png": png(), "options": {
                "maxRects": 3, "includeTaskbar": allowed, "includeWindowChrome": allowed}}, token)
            self.assertEqual(status, 200)
            self.assertTrue(0 < len(value["rects"]) <= 3)
            self.assertIn({"x": .225, "y": .175, "width": .55, "height": .65}, value["protected"])
            for r in value["rects"]:
                self.assertTrue(r["x"] + r["width"] <= .25 or r["x"] >= .75 or
                                r["y"] + r["height"] <= .2 or r["y"] >= .8)
                if not allowed:
                    self.assertGreater(r["y"], .05)
                    self.assertLess(r["y"] + r["height"], .95)
            prompt = self.upstream.requests[-1]["body"]["messages"][0]["content"]
            self.assertIn("at most 24", prompt)
            self.assertIn("may be covered" if allowed else "must not be covered", prompt)
            self.assertNotIn(token, prompt)
            self.assertEqual(self.upstream.requests[-1]["body"]["thinking"], {"type": "disabled"})
            self.assertNotIn("reasoning_effort", self.upstream.requests[-1]["body"])
            self.assertEqual(self.upstream.requests[-1]["body"]["max_tokens"], 1200)
        self.assertEqual(self.gateway.provider.extra, {"thinking": {"type": "enabled"}, "reasoning_effort": "low"})

    def test_blank_layout_keeps_content_and_returns_disjoint_regions_within_limit(self):
        blocks = [[0, 0, 1000, 60], [180, 180, 550, 470], [650, 500, 950, 850]]
        result = blank_rectangles(blocks, 5)
        self.assertTrue(0 < len(result) <= 5)
        self.assertGreater(sum(r["width"] * r["height"] for r in result), .35)
        def overlap(a, b):
            return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
        areas = [[r["x"]*1000, r["y"]*1000, (r["x"]+r["width"])*1000, (r["y"]+r["height"])*1000] for r in result]
        for i, area in enumerate(areas):
            self.assertTrue(all(0 <= n <= 1000 for n in area))
            self.assertTrue(all(overlap(area, other) == 0 for other in blocks + areas[:i]))
        self.assertEqual(blank_rectangles([[0, 0, 1000, 1000]], 5), [])
        self.assertEqual(blank_rectangles([], 1), [{"x": 0, "y": 0, "width": 1, "height": 1}])

    def test_whitespace_rejects_bad_options_and_model_coordinates(self):
        token = self.login()
        for options in ({"maxRects": 0}, {"maxRects": True}, {"maxRects": 21}, {"includeTaskbar": "yes"}):
            self.assertEqual(self.request("/whitespace", {"png": png(), "options": options}, token)[0], 400)
        self.assertEqual(len(self.upstream.requests), 0)
        for boxes in ([[0, 0, 1001, 1000]], [[0, 0, float("nan"), 500]], [[0, 0, 500, 500]] * 33,
                      [[500, 500, 300, 300]], [[False, 0, 500, 500]]):
            self.upstream.content = json.dumps({"panels": [], "blocked": boxes, "taskbar": [], "chrome": []})
            self.assertEqual(self.request("/whitespace", {"png": png()}, token)[0], 400)
        self.upstream.content = '{"panels": [], "blocked": [[0,0,1000,1000]], "taskbar": [], "chrome": []}'
        self.assertEqual(self.request("/whitespace", {"png": png()}, token), (200, {"rects": [], "protected": [{"x": 0, "y": 0, "width": 1, "height": 1}], "solid": [{"x": 0, "y": 0, "width": 1, "height": 1}]}))

    def test_auxiliary_controls_do_not_protect_card_interiors(self):
        token = self.login()
        self.upstream.content = json.dumps({"regions": [[200, 100, 800, 900]], "panels": [], "blocked": [[250, 200, 700, 400], [250, 500, 350, 750]],
            "controls": [[0, 0, 1000, 80]], "chrome": [], "taskbar": []})
        status, value = self.request("/whitespace", {"png": png()}, token)
        self.assertEqual(status, 200)
        self.assertEqual(len(value["protected"]), 2)
        self.assertIn({"x": .2, "y": .1, "width": .6, "height": .8}, value["contentRegions"])
        self.assertEqual(value["solid"], [])
        self.assertTrue(value["unprotected"])
        prompt = self.upstream.requests[-1]["body"]["messages"][0]["content"]
        self.assertIn("Empty space INSIDE a card", prompt)
        self.assertIn("answer choices", prompt)

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
