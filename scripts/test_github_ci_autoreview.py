#!/usr/bin/env python3
"""Executable standard-library tests for the GitHub CI analyzer."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest import mock
from urllib.error import HTTPError


SCRIPT = Path(__file__).with_name("github-ci-autoreview.py")
SPEC = importlib.util.spec_from_file_location("github_ci_autoreview", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules["github_ci_autoreview"] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, payload: Any, status: int = 200) -> None:
        self._body = json.dumps(payload).encode("utf-8")
        self.status = status

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class FakeOpener:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = iter(responses)
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float) -> FakeResponse:
        del timeout
        self.requests.append(request)
        response = next(self.responses)
        if isinstance(response, BaseException):
            raise response
        return response


def context() -> Any:
    return MODULE.CheckContext(
        repository="nosolosoft/opptests-backend",
        workflow_name="Backend CI",
        job_name="Backend Tests (Python 3.11)",
        details_url="https://github.com/nosolosoft/opptests-backend/actions/runs/1/job/2",
        head_sha="deadbeef",
    )


def candidate(**overrides: Any) -> dict[str, Any]:
    result = {
        "issueId": "11111111-1111-1111-1111-111111111111",
        "issueIdentifier": "NSS-999",
        "issueTitle": "Repair CI",
        "issueStatus": "blocked",
        "prUrl": "https://github.com/nosolosoft/opptests-backend/pull/999",
        "repository": "nosolosoft/opptests-backend",
        "prNumber": 999,
        "headSha": "a" * 40,
        "failureFingerprint": None,
    }
    result.update(overrides)
    return result


def failed_analysis(head_sha: str = "abc1234") -> dict[str, Any]:
    return {
        "decision": "autoreview_required",
        "pr": {
            "url": "https://github.com/nosolosoft/opptests-backend/pull/999",
            "repository": "nosolosoft/opptests-backend",
            "number": 999,
            "headSha": head_sha,
        },
        "failed_checks": [
            {
                "actionable_failures": [
                    {
                        "kind": "pytest_failed",
                        "summary": "FAILED test_real.py::test_real",
                        "fingerprint": "ffff",
                    },
                ],
                "ignored_known_noise": [],
                "non_actionable_failures": [],
            },
        ],
    }


class ClassificationTests(unittest.TestCase):
    def test_known_nss345_noise_only_is_ignored(self) -> None:
        log = """
2026-05-22T00:40:47Z =========================== short test summary info ============================
2026-05-22T00:40:47Z FAILED opptests_api/tests/test_subscription_system.py::SubscriptionAPITest::test_get_current_subscription_subscribed_user - AssertionError: 'premium' != 'basic'
"""
        result = MODULE.classify_log(log, context())
        self.assertEqual(result["decision"], "known_noise_only")
        self.assertEqual(len(result["ignored_known_noise"]), 1)
        self.assertEqual(result["ignored_known_noise"][0]["issue_key"], "NSS-345")
        self.assertEqual(result["actionable_failures"], [])

    def test_known_nss345_noise_does_not_hide_other_pytest_failures(self) -> None:
        log = """
2026-05-22T00:40:47Z FAILED opptests_api/tests/test_subscription_system.py::SubscriptionAPITest::test_get_current_subscription_subscribed_user - AssertionError: 'premium' != 'basic'
2026-05-22T00:40:47Z FAILED opptests_api/tests/test_llm_providers.py::TestLLMProviders::test_tier_config_specific_models - AssertionError: expected custom model
"""
        result = MODULE.classify_log(log, context())
        self.assertEqual(result["decision"], "autoreview_required")
        self.assertEqual(len(result["ignored_known_noise"]), 1)
        self.assertEqual(len(result["actionable_failures"]), 1)
        self.assertIn("test_llm_providers.py", result["actionable_failures"][0]["summary"])

    def test_same_text_outside_expected_repo_is_actionable(self) -> None:
        other_context = MODULE.CheckContext(
            repository="nosolosoft/opptests-web-frontend",
            workflow_name="Backend CI",
            job_name="Backend Tests (Python 3.11)",
        )
        log = "FAILED opptests_api/tests/test_subscription_system.py::SubscriptionAPITest::test_get_current_subscription_subscribed_user - AssertionError: 'premium' != 'basic'"
        result = MODULE.classify_log(log, other_context)
        self.assertEqual(result["decision"], "autoreview_required")
        self.assertEqual(result["ignored_known_noise"], [])
        self.assertEqual(len(result["actionable_failures"]), 1)

    def test_progress_line_and_summary_for_same_known_failure_are_not_double_counted(self) -> None:
        log = """
2026-05-22T00:39:45Z opptests_api/tests/test_subscription_system.py::SubscriptionAPITest::test_get_current_subscription_subscribed_user FAILED [ 77%]
2026-05-22T00:40:47Z FAILED opptests_api/tests/test_subscription_system.py::SubscriptionAPITest::test_get_current_subscription_subscribed_user - AssertionError: 'premium' != 'basic'
"""
        result = MODULE.classify_log(log, context())
        self.assertEqual(result["decision"], "known_noise_only")
        self.assertEqual(len(result["ignored_known_noise"]), 1)
        self.assertEqual(result["actionable_failures"], [])

    def test_github_permission_error_is_non_actionable_infra_not_nss345_noise(self) -> None:
        log = """
github.GithubException.GithubException: Resource not accessible by integration: 403 {"message": "Resource not accessible by integration", "documentation_url": "https://docs.github.com/rest/pulls/pulls#get-a-pull-request", "status": "403"}
"""
        result = MODULE.classify_log(log, context())
        self.assertEqual(result["decision"], "ci_infra_blocked")
        self.assertEqual(result["ignored_known_noise"], [])
        self.assertEqual(result["actionable_failures"], [])
        self.assertEqual(result["non_actionable_failures"][0]["kind"], "github_permission")


class PaperclipClientTests(unittest.TestCase):
    def test_parse_pr_url_matches_server_canonical_shape(self) -> None:
        self.assertEqual(
            MODULE.parse_pr_url(" https://github.com/acme/app/pull/42/ "),
            ("acme", "app", 42),
        )
        for url in (
            "https://github.com/acme/app/pull/042",
            "https://github.com/acme/app/pull/42/extra",
            "https://github.com/acme/app/pull/42?tab=checks",
            "https://github.com/acme/app/pull/42#checks",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    MODULE.parse_pr_url(url)

    def setUp(self) -> None:
        self.config = MODULE.PaperclipConfig(
            api_base="https://paperclip.test",
            api_key="test-key",
            company_id="33333333-3333-3333-3333-333333333333",
        )

    def test_credentials_use_cli_values_then_environment_fallbacks(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_URL": "https://env.example",
                "PAPERCLIP_API_KEY": "env-key",
                "PAPERCLIP_COMPANY_ID": "env-company",
            },
            clear=True,
        ):
            config = MODULE.resolve_paperclip_config(None, None, None)
            self.assertEqual(config.api_base, "https://env.example")
            self.assertEqual(config.api_key, "env-key")
            self.assertEqual(config.company_id, "env-company")

            override = MODULE.resolve_paperclip_config("https://cli.example/", "cli-key", "cli-company")
            self.assertEqual(override.api_base, "https://cli.example")
            self.assertEqual(override.api_key, "cli-key")
            self.assertEqual(override.company_id, "cli-company")

    def test_missing_credentials_fails_without_printing_key_material(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(MODULE.ConfigurationError) as caught:
                MODULE.resolve_paperclip_config(None, None, None)
        self.assertNotIn("test-key", str(caught.exception))

    def test_candidate_get_is_authenticated_and_uses_server_fields(self) -> None:
        opener = FakeOpener([FakeResponse([candidate()])])
        client = MODULE.PaperclipClient(self.config, opener=opener)

        candidates = client.list_candidates()

        self.assertEqual(candidates, [candidate()])
        request = opener.requests[0]
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.full_url, "https://paperclip.test/api/companies/33333333-3333-3333-3333-333333333333/github-ci/candidates")
        self.assertEqual(request.headers["Authorization"], "Bearer test-key")

    def test_report_post_sends_only_server_contract_fields(self) -> None:
        opener = FakeOpener([FakeResponse({"outcome": "created"}, status=201)])
        client = MODULE.PaperclipClient(self.config, opener=opener)
        report = {
            "issueId": candidate()["issueId"],
            "prUrl": candidate()["prUrl"],
            "repository": candidate()["repository"],
            "prNumber": candidate()["prNumber"],
            "headSha": "b" * 40,
            "fingerprint": "failure-123",
            "disposition": "failed",
            "evidence": {"actionableFailures": [{"summary": "failed"}]},
        }

        response = client.send_report(report)

        self.assertEqual(response["outcome"], "created")
        request = opener.requests[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body, report)
        self.assertNotIn("status", body)
        self.assertNotIn("assigneeAgentId", body)
        self.assertNotIn("blockedByIssueIds", body)
        self.assertNotIn("qaVerdict", body)
        self.assertNotIn("taskId", body)

    def test_401_and_409_are_typed_api_errors_without_retry(self) -> None:
        for status in (401, 409):
            opener = FakeOpener([
                HTTPError(
                    "https://paperclip.test/api",
                    status,
                    "rejected",
                    {},
                    io.BytesIO(json.dumps({"code": "rejected"}).encode()),
                ),
            ])
            client = MODULE.PaperclipClient(self.config, opener=opener)
            with self.assertRaises(MODULE.PaperclipApiError) as caught:
                client.list_candidates()
            self.assertEqual(caught.exception.status, status)
            self.assertNotIn("test-key", str(caught.exception))
            self.assertEqual(len(opener.requests), 1)

    def test_malformed_candidate_response_is_rejected_at_api_boundary(self) -> None:
        opener = FakeOpener([FakeResponse({"not": "a list"})])
        client = MODULE.PaperclipClient(self.config, opener=opener)

        with self.assertRaises(MODULE.PaperclipApiError):
            client.list_candidates()


class ReportTests(unittest.TestCase):
    def test_dry_run_returns_payload_without_http_mutation(self) -> None:
        client = mock.Mock()
        result = MODULE.enqueue_autoreview(candidate(), failed_analysis(), client=client, dry_run=True)

        self.assertFalse(result["queued"])
        self.assertTrue(result["dry_run"])
        self.assertIn("github-ci-autoreview:", result["idempotency_key"])
        self.assertEqual(result["payload"]["issueId"], candidate()["issueId"])
        self.assertEqual(result["payload"]["prUrl"], candidate()["prUrl"])
        self.assertEqual(result["payload"]["prNumber"], candidate()["prNumber"])
        client.send_report.assert_not_called()

    def test_failed_report_uses_current_head_and_marks_stale_candidate_head_as_evidence(self) -> None:
        client = mock.Mock()
        analysis = failed_analysis(head_sha="c" * 40)
        result = MODULE.enqueue_autoreview(candidate(headSha="d" * 40), analysis, client=client, dry_run=False)

        self.assertTrue(result["queued"])
        report = client.send_report.call_args.args[0]
        self.assertEqual(report["headSha"], "c" * 40)
        self.assertEqual(report["evidence"]["candidateHeadSha"], "d" * 40)
        self.assertEqual(report["disposition"], "failed")

    def test_green_report_requires_explicit_failure_fingerprint_and_sends_passed(self) -> None:
        client = mock.Mock()
        analysis = {
            "decision": "green_or_no_failed_checks",
            "pr": {
                "url": candidate()["prUrl"],
                "repository": candidate()["repository"],
                "number": candidate()["prNumber"],
                "headSha": "e" * 40,
            },
            "failed_checks": [],
        }

        missing = MODULE.enqueue_autoreview(candidate(), analysis, client=client, dry_run=False)
        self.assertFalse(missing["queued"])
        self.assertEqual(missing["reason"], "green_report_requires_fingerprint")
        client.send_report.assert_not_called()

        sent = MODULE.enqueue_autoreview(
            candidate(),
            analysis,
            client=client,
            dry_run=False,
            failure_fingerprint="failure-123",
        )
        self.assertTrue(sent["queued"])
        self.assertEqual(client.send_report.call_args.args[0]["disposition"], "passed")
        self.assertEqual(client.send_report.call_args.args[0]["fingerprint"], "failure-123")

    def test_green_report_uses_candidate_failure_fingerprint(self) -> None:
        client = mock.Mock()
        analysis = {
            "decision": "green_or_no_failed_checks",
            "pr": {
                "url": candidate()["prUrl"],
                "repository": candidate()["repository"],
                "number": candidate()["prNumber"],
                "headSha": "e" * 40,
            },
            "failed_checks": [],
        }

        result = MODULE.enqueue_autoreview(
            candidate(failureFingerprint="server-failure-123"),
            analysis,
            client=client,
            dry_run=False,
        )

        self.assertTrue(result["queued"])
        self.assertEqual(client.send_report.call_args.args[0]["disposition"], "passed")
        self.assertEqual(client.send_report.call_args.args[0]["fingerprint"], "server-failure-123")

    def test_no_owner_is_server_error_not_client_inferred_mutation(self) -> None:
        error = MODULE.PaperclipApiError(422, "github_ci_owner_unavailable", "/reports")
        client = mock.Mock()
        client.send_report.side_effect = error

        with self.assertRaises(MODULE.PaperclipApiError):
            MODULE.enqueue_autoreview(candidate(), failed_analysis(), client=client, dry_run=False)
        report = client.send_report.call_args.args[0]
        self.assertNotIn("assigneeAgentId", report)


class RunnerTests(unittest.TestCase):
    def test_scan_runner_uses_fake_gh_and_authenticated_get_post(self) -> None:
        responses = FakeOpener([
            FakeResponse([candidate(issueId="44444444-4444-4444-4444-444444444444")]),
            FakeResponse({"outcome": "created"}, status=201),
        ])
        pr = {
            "number": 999,
            "title": "Repair CI",
            "url": candidate()["prUrl"],
            "headRefName": "fix-ci",
            "headRefOid": "f" * 40,
            "statusCheckRollup": [
                {
                    "conclusion": "FAILURE",
                    "status": "COMPLETED",
                    "workflowName": "Backend CI",
                    "name": "Backend Tests (Python 3.11)",
                    "detailsUrl": "https://github.com/nosolosoft/opptests-backend/actions/runs/1/job/2",
                },
            ],
        }

        def fake_run(command: list[str], **_kwargs: Any) -> Any:
            if command[1:3] == ["pr", "view"]:
                return subprocess.CompletedProcess(command, 0, json.dumps(pr), "")
            if command[1:3] == ["api", "repos/nosolosoft/opptests-backend/actions/jobs/2/logs"]:
                return subprocess.CompletedProcess(command, 0, "FAILED test_real.py::test_real - AssertionError: broken\n", "")
            raise AssertionError(command)

        with mock.patch.object(MODULE, "urlopen", responses), mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with contextlib.redirect_stdout(io.StringIO()):
                code = MODULE.main([
                    "--scan-paperclip",
                    "--enqueue",
                    "--api-base",
                    "https://paperclip.test",
                    "--api-key",
                    "test-key",
                    "--company-id",
                    "33333333-3333-3333-3333-333333333333",
                    "--json",
                ])

        self.assertEqual(code, 0)
        self.assertEqual([request.method for request in responses.requests], ["GET", "POST"])
        report = json.loads(responses.requests[1].data.decode("utf-8"))
        self.assertEqual(report["issueId"], "44444444-4444-4444-4444-444444444444")
        self.assertEqual(report["prNumber"], 999)

    def test_runner_continues_after_one_pr_error_and_returns_nonzero(self) -> None:
        responses = FakeOpener([FakeResponse([candidate(), candidate(issueId="55555555-5555-5555-5555-555555555555")])])
        outputs = iter([
            RuntimeError("first GitHub failure"),
            {
                "number": 999,
                "title": "Repair CI",
                "url": candidate()["prUrl"],
                "headRefName": "fix-ci",
                "headRefOid": "f" * 40,
                "statusCheckRollup": [],
            },
        ])

        def fake_analyze(_url: str) -> dict[str, Any]:
            value = next(outputs)
            if isinstance(value, RuntimeError):
                raise value
            return {
                "decision": "green_or_no_failed_checks",
                "pr": {
                    "url": value["url"],
                    "repository": "nosolosoft/opptests-backend",
                    "number": 999,
                    "headSha": value["headRefOid"],
                },
                "failed_checks": [],
                "actionable_failure_count": 0,
                "ignored_known_noise_count": 0,
                "non_actionable_failure_count": 0,
            }

        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(MODULE, "urlopen", responses), mock.patch.object(MODULE, "analyze_pr", side_effect=fake_analyze):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = MODULE.main([
                    "--scan-paperclip",
                    "--api-base",
                    "https://paperclip.test",
                    "--api-key",
                    "test-key",
                    "--company-id",
                    "33333333-3333-3333-3333-333333333333",
                ])

        self.assertEqual(code, 1)
        self.assertIn("skipping invalid/unavailable PR", stderr.getvalue())
        self.assertIn("NSS-999", stdout.getvalue())

    def test_scan_dry_run_fetches_candidates_but_does_not_post(self) -> None:
        responses = FakeOpener([FakeResponse([candidate()])])
        analysis = failed_analysis(head_sha="f" * 40)
        with mock.patch.object(MODULE, "urlopen", responses), mock.patch.object(MODULE, "analyze_pr", return_value=analysis):
            with contextlib.redirect_stdout(io.StringIO()):
                code = MODULE.main([
                    "--scan-paperclip",
                    "--api-base",
                    "https://paperclip.test",
                    "--api-key",
                    "test-key",
                    "--company-id",
                    "33333333-3333-3333-3333-333333333333",
                    "--json",
                ])

        self.assertEqual(code, 0)
        self.assertEqual([request.method for request in responses.requests], ["GET"])

    def test_real_direct_enqueue_requires_explicit_issue_target(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                MODULE.main([
                    "--pr-url",
                    "https://github.com/acme/app/pull/42",
                    "--enqueue",
                ])
        self.assertEqual(caught.exception.code, 2)

    def test_script_has_no_direct_database_dependency(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        forbidden_tokens = (
            "p" + "sql",
            "PAPERCLIP" + "_DB_",
            "agent_" + "wakeup_" + "requests",
        )
        for token in forbidden_tokens:
            with self.subTest(token=token):
                self.assertNotIn(token, source)

    def test_test_file_is_executable_with_python(self) -> None:
        process = subprocess.run(
            [sys.executable, str(__file__), "PaperclipClientTests.test_credentials_use_cli_values_then_environment_fallbacks"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(process.returncode, 0, process.stderr)


if __name__ == "__main__":
    unittest.main()
