import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

import health_summary


@dataclass(frozen=True)
class FakeProject:
    name: str
    root: Path
    label: str = ""
    default_mode: str = "readonly"
    allowed_modes: tuple[str, ...] = ("readonly",)
    description: str = ""


@dataclass(frozen=True)
class FakeConfig:
    projects: dict[str, FakeProject]


@dataclass(frozen=True)
class FakePrincipal:
    user: str
    role: str = "admin"


class HealthSummaryTests(unittest.TestCase):
    def test_safe_control_text_redacts_paths_and_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig({"demo": FakeProject("demo", root)})
            text = (
                f"path={root}/private Authorization: Bearer secret-token-123 "
                "OPENAI_API_KEY=abc123 sk-proj-abcdefghijklmnopqrstuvwxyz "
                "ghp_abcdefghijklmnopqrstuvwxyz123456"
            )

            safe = health_summary.safe_control_text(config, text)

        self.assertIn("[workspace:demo]", safe)
        self.assertIn("Authorization: Bearer [REDACTED]", safe)
        self.assertIn("OPENAI_API_KEY=[REDACTED_SECRET]", safe)
        self.assertIn("[REDACTED_OPENAI_KEY]", safe)
        self.assertIn("[REDACTED_GITHUB_TOKEN]", safe)
        self.assertNotIn(str(root), safe)

    def test_workspaces_and_capabilities_are_sorted_and_mode_aware(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(
                {
                    "zeta": FakeProject("zeta", root / "zeta"),
                    "alpha": FakeProject(
                        "alpha",
                        root / "alpha",
                        label="Alpha",
                        default_mode="workspace-write",
                        allowed_modes=("workspace-write",),
                    ),
                }
            )

            workspaces = health_summary.handle_codex_workspaces(config)
            capabilities = health_summary.handle_codex_capabilities(config, version="mvp-v0.7")

        self.assertEqual([item["id"] for item in workspaces["workspaces"]], ["alpha", "zeta"])
        self.assertEqual(workspaces["workspaces"][0]["label"], "Alpha")
        self.assertTrue(capabilities["features"]["write_mode"])
        self.assertEqual(capabilities["modes"], ["readonly", "workspace-write"])

    def test_handle_health_summary_aggregates_recent_tasks_and_supervisor_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_root = root / "demo"
            agent_dir = project_root / "agent"
            agent_dir.mkdir(parents=True)
            (agent_dir / "RUN_STATE.json").write_text(
                json.dumps(
                    {
                        "role": "runner",
                        "supervisor_mode": "light",
                        "runner_started_count": 5,
                        "runner_completed_count": 3,
                        "runner_failure_drift": 2,
                        "status": "blocked",
                        "blocker_type": "env",
                        "requires_human_review": True,
                        "updated_utc": "2026-06-17T12:00:00Z",
                        "next_action": {
                            "kind": "repair",
                            "description": f"Inspect {project_root}/private and Authorization: Bearer secret-token-12345",
                            "can_execute_automatically": False,
                            "reason": "Needs reviewer approval",
                        },
                    }
                )
            )
            (agent_dir / "NEXT_ACTION.md").write_text("Fallback next action")
            (agent_dir / "BLOCKERS.md").write_text(
                f"Blockers mention {project_root}/private and ghp_abcdefghijklmnopqrstuvwxyz123456"
            )
            config = FakeConfig({"demo": FakeProject("demo", project_root)})

            response = health_summary.handle_health_summary(
                config,
                FakePrincipal("chenma"),
                deps=health_summary.HealthSummaryDependencies(
                    read_recent_task_summaries=lambda _config, _principal, _limit: [
                        {"task_id": "task_done", "status": "done"},
                        {"task_id": "task_run", "status": "running"},
                    ]
                ),
                version="mvp-v0.7",
                active_statuses={"running", "queued"},
                final_statuses={"done", "failed"},
                allowed_blockers={"none", "unknown", "env"},
                supervisor_text_max_chars=500,
            )

            text = json.dumps(response, ensure_ascii=False)

        self.assertTrue(response["ok"])
        self.assertEqual(response["tasks"]["recent_count"], 2)
        self.assertEqual(response["tasks"]["active_count"], 1)
        self.assertEqual(response["tasks"]["terminal_count"], 1)
        self.assertEqual(response["supervisor"]["blocked_count"], 1)
        self.assertEqual(response["supervisor"]["review_required_count"], 1)
        self.assertEqual(response["supervisor"]["runner_drift_count"], 1)
        signal = response["supervisor"]["signals"][0]
        self.assertEqual(signal["workspace"], "demo")
        self.assertEqual(signal["role"], "runner")
        self.assertEqual(signal["blocker_type"], "env")
        self.assertIn("[workspace:demo]", signal["next_action"]["description"])
        self.assertNotIn(str(project_root), text)
        self.assertNotIn("secret-token-12345", text)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz123456", text)

    def test_handle_health_summary_normalizes_multi_workspace_supervisor_signals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            alpha_root = root / "alpha"
            beta_root = root / "beta"
            alpha_agent = alpha_root / "agent"
            beta_agent = beta_root / "agent"
            alpha_agent.mkdir(parents=True)
            beta_agent.mkdir(parents=True)

            (alpha_agent / "RUN_STATE.json").write_text(
                json.dumps(
                    {
                        "role": "watchdog",
                        "supervisor_mode": "audit",
                        "runner_started_count": "12",
                        "runner_completed_count": "9",
                        "runner_failure_drift": "NaN",
                        "status": "waiting",
                        "blocker_type": "mystery",
                        "requires_human_review": False,
                        "updated_utc": "2026-06-17T15:00:00Z",
                        "next_action": {
                            "kind": "review",
                            "description": "",
                            "can_execute_automatically": False,
                            "reason": "Awaiting bounded review",
                        },
                    }
                )
            )
            (alpha_agent / "NEXT_ACTION.md").write_text(
                f"Review {alpha_root}/private Authorization: Bearer secret-token-12345 "
                + ("alpha " * 80)
            )
            (alpha_agent / "BLOCKERS.md").write_text(
                f"Alpha blockers {alpha_root}/private ghp_abcdefghijklmnopqrstuvwxyz123456 " + ("block " * 80)
            )

            (beta_agent / "RUN_STATE.json").write_text(
                json.dumps(
                    {
                        "role": "supervisor",
                        "supervisor_mode": "light",
                        "runner_started_count": 4,
                        "runner_completed_count": 4,
                        "runner_failure_drift": 0,
                        "status": "ready",
                        "blocker_type": "none",
                        "requires_human_review": True,
                        "updated_utc": "2026-06-17T15:05:00Z",
                        "next_action": {
                            "kind": "monitor",
                            "description": f"Monitor {beta_root}/safe-state",
                            "can_execute_automatically": True,
                            "reason": "Normal steady-state operation",
                        },
                    }
                )
            )
            (beta_agent / "BLOCKERS.md").write_text("No blockers")

            config = FakeConfig(
                {
                    "beta": FakeProject("beta", beta_root),
                    "alpha": FakeProject("alpha", alpha_root),
                }
            )

            response = health_summary.handle_health_summary(
                config,
                FakePrincipal("chenma"),
                deps=health_summary.HealthSummaryDependencies(
                    read_recent_task_summaries=lambda _config, _principal, _limit: [
                        {"task_id": "task_done", "status": "done"},
                    ]
                ),
                version="mvp-v0.7",
                active_statuses={"running", "queued"},
                final_statuses={"done", "failed"},
                allowed_blockers={"none", "unknown", "env"},
                supervisor_text_max_chars=120,
            )
            text = json.dumps(response, ensure_ascii=False)

        self.assertTrue(response["ok"])
        self.assertEqual(response["supervisor"]["workspace_count"], 2)
        self.assertEqual(response["supervisor"]["blocked_count"], 0)
        self.assertEqual(response["supervisor"]["review_required_count"], 1)
        self.assertEqual(response["supervisor"]["runner_drift_count"], 0)

        alpha_signal, beta_signal = response["supervisor"]["signals"]
        self.assertEqual(alpha_signal["workspace"], "alpha")
        self.assertEqual(alpha_signal["role"], "unknown")
        self.assertEqual(alpha_signal["blocker_type"], "unknown")
        self.assertEqual(alpha_signal["runner_failure_drift"], "unknown")
        self.assertIn("[workspace:alpha]", alpha_signal["next_action"]["description"])
        self.assertTrue(alpha_signal["next_action"]["description"].endswith("...(truncated)"))
        self.assertIn("[workspace:alpha]", alpha_signal["blockers_preview"])
        self.assertTrue(alpha_signal["blockers_preview"].endswith("...(truncated)"))

        self.assertEqual(beta_signal["workspace"], "beta")
        self.assertEqual(beta_signal["role"], "supervisor")
        self.assertEqual(beta_signal["blocker_type"], "none")
        self.assertEqual(beta_signal["runner_failure_drift"], "0")
        self.assertTrue(beta_signal["requires_human_review"])
        self.assertEqual(beta_signal["next_action"]["kind"], "monitor")
        self.assertIn("[workspace:beta]", beta_signal["next_action"]["description"])

        self.assertNotIn(str(alpha_root), text)
        self.assertNotIn(str(beta_root), text)
        self.assertNotIn("secret-token-12345", text)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz123456", text)

    def test_safe_codex_status_text_masks_project_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig({"demo": FakeProject("demo", root)})
            text = (
                f"project_path: {root}\n"
                f"worktree: {root}/nested\n"
                "Authorization: Bearer secret-token-12345\n"
            )

            safe = health_summary.safe_codex_status_text(
                config,
                {"project": "demo", "project_path": str(root)},
                text,
            )

        self.assertIn("project_path: [workspace:demo]", safe)
        self.assertIn("[workspace:demo]/nested", safe)
        self.assertIn("Authorization: Bearer [REDACTED]", safe)
        self.assertNotIn(str(root), safe)


if __name__ == "__main__":
    unittest.main()
