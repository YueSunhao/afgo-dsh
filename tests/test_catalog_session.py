import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "afg", Path(__file__).resolve().parents[1] / "scripts" / "afg.py")
afg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(afg)


class CatalogTests(unittest.TestCase):
    def test_search_display_name_keeps_versions_of_the_registration(self):
        entries = [
            {"name": "other", "display_name": "Other", "description": "Water energy"},
            {"name": "sample", "display_name": "Legacy label", "version": "1.2.0"},
            {"name": "sample", "display_name": "Water energy", "version": "1.10.0"},
            {"name": "alternate", "display_name": "Water energy", "version": "1.0.0"},
        ]
        for kind, argv in (("agents", ["agents"]), ("kits", ["kits", "list"])):
            args = afg.build_parser().parse_args(argv + ["--query", "ＷＡＴＥＲ energy"])
            with patch.object(afg, "request", return_value={"success": True, "data": {"toolboxes": entries}}):
                result = args.func(args)
            self.assertEqual(["sample", "alternate", "other"], [t["name"] for t in result[kind]])
            self.assertEqual(["1.2.0", "1.10.0"], result[kind][0]["versions"])

    def test_version_sources_and_schema_ambiguity(self):
        base = "https://example.test/toolbox-demos/prod/sample/"
        icon = "https://example.test/toolbox-icons/sample/1.1.0/icon.svg"
        item = {"name": "sample", "demos": [{"files": [base + "1.0.0/a.xyz"]}]}
        self.assertEqual("demo", afg._toolbox_entry(item)["version_source"])
        self.assertEqual("1.1.0", afg._toolbox_entry(dict(item, icon=icon))["version"])
        self.assertEqual("version", afg._toolbox_entry(dict(item, version="1.3.0", icon=icon))["version_source"])
        unrelated = {"name": "other", "demos": item["demos"]}
        self.assertNotIn("version", afg._toolbox_entry(unrelated))
        rows = [dict(item, version="1.0.0", input_schema={"fields": []}),
                dict(item, version="1.1.0", input_schema={"fields": [{"name": "x"}]})]
        with self.assertRaisesRegex(afg.AfgError, "不同的输入 schema"):
            afg._select_kit(rows, "sample")
        self.assertEqual(rows[1]["input_schema"], afg._select_kit(rows, "sample", "1.1.0")["input_schema"])


class SessionTests(unittest.TestCase):
    def invoke(self, args, response):
        args = afg.build_parser().parse_args(["wf", "session", *args])
        with patch.object(afg, "request", return_value=response) as request:
            result = args.func(args)
        return result, request.call_args

    def test_plan_and_session_response_shapes(self):
        result, call = self.invoke(["plan-create", "--prompt", "Test", "--file", "f", "--workspace-id", "4"], {"id": 12})
        self.assertEqual({"id": 12}, result)
        self.assertEqual(("POST", "/workflow"), call.args)
        self.assertEqual({"prompt": "Test", "file_ids": ["f"]}, call.kwargs["body"])
        self.assertEqual({"workspace_id": 4}, call.kwargs["query"])
        self.assertEqual("", call.kwargs["prefix"])
        self.assertTrue(call.kwargs["bearer"])
        result, call = self.invoke(["create", "12"], {"data": {"opencode_session_id": "sid"}})
        self.assertEqual({"opencode_session_id": "sid"}, result)
        self.assertEqual(("POST", "/openagent/sessions"), call.args)
        self.assertEqual({"plan_id": 12}, call.kwargs["body"])
        _, call = self.invoke(["list", "12"], {"data": {"sessions": []}})
        self.assertEqual(("GET", "/openagent/sessions"), call.args)
        self.assertEqual({"plan_id": 12}, call.kwargs["query"])

    def test_send_messages_and_abort(self):
        result, call = self.invoke(["send", "sid", "--message", "Test"], "")
        self.assertEqual({"accepted": True}, result)
        self.assertEqual(("POST", "/openagent/sessions/sid/prompt_async"), call.args)
        self.assertEqual({"parts": [{"type": "text", "text": "Test"}]}, call.kwargs["body"])
        with patch.object(afg, "LAST_HEADERS", {"X-Next-Cursor": "cursor"}):
            result, call = self.invoke(["messages", "sid", "--before", "old"], [])
        self.assertEqual({"messages": [], "next_cursor": "cursor"}, result)
        self.assertEqual({"limit": None, "before": "old"}, call.kwargs["query"])
        result, call = self.invoke(["abort", "sid"], {"data": {"computation_cancelled": False}})
        self.assertEqual(("POST", "/openagent/sessions/sid/abort"), call.args)
        self.assertIs(result["computation_cancelled"], False)

    def test_event_window(self):
        source = io.BytesIO(b': heartbeat\n\nid: 1\nevent: update\ndata: {"x": 2}\n\ndata: next\n\n')
        self.assertEqual({"events": [{"id": "1", "event": "update", "data": {"x": 2}}],
                          "stopped": "limit"}, afg._read_events(source, 1, 10))
        _, call = self.invoke(["events", "sid", "--limit", "1", "--seconds", "5"], {})
        self.assertEqual(("GET", "/openagent/event"), call.args)
        self.assertEqual({"session_id": "sid"}, call.kwargs["query"])
        self.assertEqual(1, call.kwargs["event_limit"])
        self.assertEqual(5, call.kwargs["timeout"])


if __name__ == "__main__":
    unittest.main()
