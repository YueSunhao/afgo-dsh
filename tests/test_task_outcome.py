import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "afg", Path(__file__).resolve().parents[1] / "scripts" / "afg.py")
afg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(afg)


class TaskOutcomeTests(unittest.TestCase):
    """The workbench shows this verdict as-is, so its failure list must match the page's."""

    def test_scheduler_failures_including_out_of_memory_are_failures(self):
        for job in ("FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "OUT_OF_MEMORY"):
            outcome = afg._task_outcome({"is_thinking": False, "steps": [{"slurm_job_status": job.lower()}]})
            self.assertEqual(outcome["state"], "failed", job)
            self.assertIn("slurm=%s" % job, outcome["evidence"])

    def test_success_needs_data_fields_or_an_explicit_flag(self):
        data = {"is_thinking": False, "steps": [{"tool_data": {"structured_output": {"gamma": 1.61}}}]}
        self.assertEqual(afg._task_outcome(data)["state"], "success")
        bare = {"is_thinking": False, "steps": [{"tool_data": {"structured_output": {"message": "ok"}}}]}
        self.assertEqual(afg._task_outcome(bare)["state"], "unknown")
        flagged = {"is_thinking": False, "steps": [{"tool_data": {"structured_output": {"success": False, "gamma": 1}}}]}
        self.assertEqual(afg._task_outcome(flagged)["state"], "failed")


if __name__ == "__main__":
    unittest.main()
