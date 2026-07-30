#!/usr/bin/env python3
"""Paperclip GitHub CI failure autoreview gate.

Scans GitHub PR checks, separates known CI noise from actionable failures, and
(optionally) submits a server-validated Paperclip CI report. Paperclip resolves
recovery ownership and wake gates. The important invariant is that known noise
never hides other failures: if any actionable failure remains after filtering,
the PR is still treated as red.

Default mode is dry-run. Use --enqueue to submit authenticated CI reports.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import re
import subprocess
import sys
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TERMINAL_CHECK_CONCLUSIONS = {
    "SUCCESS",
    "NEUTRAL",
    "SKIPPED",
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
}
FAILURE_CHECK_CONCLUSIONS = {
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
}

GITHUB_LOG_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+")
GITHUB_PR_URL_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?$",
    re.IGNORECASE,
)
PYTEST_SUMMARY_RE = re.compile(r"^(FAILED|ERROR)\s+([^\s]+)(?:\s+-\s+(.*))?$")
PYTEST_PROGRESS_FAIL_RE = re.compile(r"([^\s]+::[^\s]+)\s+(FAILED|ERROR)\s+\[")


@dataclasses.dataclass(frozen=True, slots=True)
class CheckContext:
    repository: str
    workflow_name: str | None = None
    job_name: str | None = None
    details_url: str | None = None
    head_sha: str | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class FailureSignal:
    kind: str
    summary: str
    source: str | None = None
    detail: str | None = None

    def fingerprint(self) -> str:
        raw = "\0".join([self.kind, self.source or "", self.summary, self.detail or ""])
        return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:16]


@dataclasses.dataclass(frozen=True, slots=True)
class PaperclipConfig:
    """Authenticated Paperclip API connection settings."""

    api_base: str
    api_key: str
    company_id: str


class ConfigurationError(RuntimeError):
    """Raised when required Paperclip client configuration is absent."""


class PaperclipApiError(RuntimeError):
    """Raised when Paperclip rejects or returns an invalid client response."""

    def __init__(self, status: int, code: str, path: str) -> None:
        self.status = status
        self.code = code
        self.path = path
        super().__init__(f"Paperclip API request failed ({status}): {code}")


def resolve_paperclip_config(
    api_base: str | None,
    api_key: str | None,
    company_id: str | None,
) -> PaperclipConfig:
    """Resolve CLI/env values, then the local Paperclip board credential."""
    resolved_base = (api_base or os.getenv("PAPERCLIP_API_BASE") or os.getenv("PAPERCLIP_API_URL") or "").strip().rstrip("/")
    resolved_key = (api_key or os.getenv("PAPERCLIP_API_KEY") or "").strip()
    resolved_company = (company_id or os.getenv("PAPERCLIP_COMPANY_ID") or "").strip()

    # Script-only crons do not inherit the interactive CLI environment. Reuse
    # the local board credential for the same API base without embedding a key
    # in the cron or repository.
    if resolved_base and not resolved_key:
        auth_path = os.getenv("PAPERCLIP_AUTH_FILE", os.path.expanduser("~/.paperclip/auth.json"))
        try:
            with open(auth_path, encoding="utf-8") as handle:
                credentials = json.load(handle).get("credentials", {})
            entry = credentials.get(resolved_base, {})
            resolved_key = str(entry.get("token", "")).strip()
        except (OSError, ValueError, TypeError):
            resolved_key = ""
    missing = [
        name
        for name, value in (
            ("api-base", resolved_base),
            ("api-key", resolved_key),
            ("company-id", resolved_company),
        )
        if not value
    ]
    if missing:
        raise ConfigurationError("Missing Paperclip configuration: " + ", ".join(missing))
    return PaperclipConfig(api_base=resolved_base, api_key=resolved_key, company_id=resolved_company)


def _api_error_code(body: bytes) -> str:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return "invalid_response"
    if isinstance(payload, dict):
        for key in ("code", "error", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:160]
    return "invalid_response"


def _require_candidate(candidate: Any) -> dict[str, Any]:
    if not isinstance(candidate, dict):
        raise PaperclipApiError(200, "malformed_candidate", "/github-ci/candidates")
    required = {
        "issueId": str,
        "issueTitle": str,
        "issueStatus": str,
        "prUrl": str,
        "repository": str,
        "prNumber": int,
    }
    for key, value_type in required.items():
        value = candidate.get(key)
        if not isinstance(value, value_type) or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
            raise PaperclipApiError(200, f"malformed_candidate_{key}", "/github-ci/candidates")
    if "issueIdentifier" not in candidate or candidate["issueIdentifier"] is not None and not isinstance(candidate["issueIdentifier"], str):
        raise PaperclipApiError(200, "malformed_candidate_issueIdentifier", "/github-ci/candidates")
    if "headSha" not in candidate or candidate["headSha"] is not None and not isinstance(candidate["headSha"], str):
        raise PaperclipApiError(200, "malformed_candidate_headSha", "/github-ci/candidates")
    if "failureFingerprint" not in candidate or candidate["failureFingerprint"] is not None and not isinstance(candidate["failureFingerprint"], str):
        raise PaperclipApiError(200, "malformed_candidate_failureFingerprint", "/github-ci/candidates")
    return candidate


class PaperclipClient:
    """Small standard-library client for the GitHub CI Paperclip endpoints."""

    def __init__(self, config: PaperclipConfig, opener: Any | None = None) -> None:
        self.config = config
        self._opener = opener or urlopen

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        request = Request(
            f"{self.config.api_base}{path}",
            data=body,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.config.api_key}",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
            method=method,
        )
        try:
            with self._opener(request, timeout=30) as response:
                raw = response.read()
        except HTTPError as error:
            raise PaperclipApiError(error.code, _api_error_code(error.read()), path) from None
        except URLError as error:
            raise PaperclipApiError(0, f"connection_error:{error.reason}", path) from None
        except OSError as error:
            raise PaperclipApiError(0, f"connection_error:{type(error).__name__}", path) from None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise PaperclipApiError(200, "invalid_response", path) from None

    def list_candidates(self) -> list[dict[str, Any]]:
        """Return server-owned active GitHub PR candidates for this company."""
        path = f"/api/companies/{self.config.company_id}/github-ci/candidates"
        payload = self._request("GET", path)
        if not isinstance(payload, list):
            raise PaperclipApiError(200, "malformed_candidates_response", path)
        return [_require_candidate(item) for item in payload]

    def send_report(self, report: dict[str, Any]) -> dict[str, Any]:
        """Submit one server-validated failed or passed CI report."""
        path = f"/api/companies/{self.config.company_id}/github-ci/reports"
        payload = self._request("POST", path, report)
        if not isinstance(payload, dict):
            raise PaperclipApiError(200, "malformed_report_response", path)
        return payload


@dataclasses.dataclass(frozen=True)
class KnownNoiseRule:
    id: str
    issue_key: str
    description: str
    summary_regex: str
    repository_regex: str | None = None
    workflow_regex: str | None = None
    job_regex: str | None = None
    expires: str | None = None

    def matches(self, signal: FailureSignal, context: CheckContext) -> bool:
        if self.repository_regex and not re.search(self.repository_regex, context.repository, re.I):
            return False
        if self.workflow_regex and not re.search(self.workflow_regex, context.workflow_name or "", re.I):
            return False
        if self.job_regex and not re.search(self.job_regex, context.job_name or "", re.I):
            return False
        haystack = "\n".join(part for part in [signal.summary, signal.source or "", signal.detail or ""] if part)
        return re.search(self.summary_regex, haystack, re.I | re.S) is not None


KNOWN_NOISE_RULES: tuple[KnownNoiseRule, ...] = (
    KnownNoiseRule(
        id="nss-345-backend-subscription-tier-default-drift",
        issue_key="NSS-345",
        description=(
            "Known unrelated backend CI noise observed while isolating NSS-345: "
            "SubscriptionAPITest.test_get_current_subscription_subscribed_user "
            "expects basic but receives premium. Ignore only this exact pytest "
            "failure; do not ignore the whole job."
        ),
        repository_regex=r"^nosolosoft/opptests-backend$",
        workflow_regex=r"^Backend CI$",
        job_regex=r"Backend Tests \(Python 3\.11\)",
        summary_regex=(
            r"opptests_api/tests/test_subscription_system\.py::"
            r"SubscriptionAPITest::test_get_current_subscription_subscribed_user"
            r".*AssertionError:\s*'premium'\s*!=\s*'basic'"
        ),
    ),
)


def strip_github_log_prefix(line: str) -> str:
    return GITHUB_LOG_PREFIX_RE.sub("", line).rstrip()


def parse_pr_url(url: str) -> tuple[str, str, int]:
    match = GITHUB_PR_URL_RE.fullmatch(url.strip())
    if not match:
        raise ValueError(f"Not a GitHub pull request URL: {url}")
    owner, repo, number = match.groups()
    return owner, repo, int(number)


def extract_failure_signals(log_text: str) -> list[FailureSignal]:
    """Extract structured failure signals without treating every stderr line as actionable."""
    signals: list[FailureSignal] = []
    seen: set[tuple[str, str, str | None]] = set()
    lines = [strip_github_log_prefix(line) for line in log_text.splitlines()]

    for line in lines:
        m = PYTEST_SUMMARY_RE.match(line)
        if m:
            kind = "pytest_" + m.group(1).lower()
            source = m.group(2)
            detail = (m.group(3) or "").strip() or None
            summary = f"{m.group(1)} {source}" + (f" - {detail}" if detail else "")
            key = (kind, source, detail)
            if key not in seen:
                signals.append(FailureSignal(kind=kind, source=source, detail=detail, summary=summary))
                seen.add(key)
            continue

        # Progress lines appear earlier than the final summary. Keep them only
        # when no final detail is available; duplicate removal avoids spam.
        m = PYTEST_PROGRESS_FAIL_RE.search(line)
        if m:
            source = m.group(1)
            outcome = m.group(2)
            kind = "pytest_" + outcome.lower()
            key = (kind, source, None)
            if key not in seen:
                signals.append(FailureSignal(kind=kind, source=source, detail=None, summary=f"{outcome} {source}"))
                seen.add(key)

    # Prefer final pytest short-summary entries over earlier progress lines for
    # the same test. Otherwise a known noisy failure can appear once as ignored
    # (summary) and once as actionable (progress line), which would violate the
    # NSS-345 filter semantics.
    preferred: dict[tuple[str, str | None], FailureSignal] = {}
    passthrough: list[FailureSignal] = []
    for signal in signals:
        if signal.kind.startswith("pytest_"):
            key = (signal.kind, signal.source)
            current = preferred.get(key)
            if current is None or (not current.detail and signal.detail):
                preferred[key] = signal
        else:
            passthrough.append(signal)
    signals = list(preferred.values()) + passthrough

    # GitHub permission/reporting errors are infra signals. They should not hide
    # pytest failures; they become actionable only if they are the only signal.
    joined = "\n".join(lines)
    if "Resource not accessible by integration" in joined and "docs.github.com/rest/pulls/pulls#get-a-pull-request" in joined:
        key = ("github_permission", "pulls#get-a-pull-request", "403")
        if key not in seen:
            signals.append(
                FailureSignal(
                    kind="github_permission",
                    source="GitHub API pulls#get-a-pull-request",
                    detail="Resource not accessible by integration: 403",
                    summary="GitHub API permission error while reading pull request metadata",
                )
            )

    return signals


def classify_signals(
    signals: Iterable[FailureSignal],
    context: CheckContext,
    known_rules: Iterable[KnownNoiseRule] = KNOWN_NOISE_RULES,
) -> dict[str, Any]:
    ignored: list[dict[str, Any]] = []
    infra: list[dict[str, Any]] = []
    actionable: list[dict[str, Any]] = []
    rules = list(known_rules)

    for signal in signals:
        matching_rule = next((rule for rule in rules if rule.matches(signal, context)), None)
        item = dataclasses.asdict(signal) | {"fingerprint": signal.fingerprint()}
        if matching_rule:
            ignored.append(
                item
                | {
                    "ignored_by": matching_rule.id,
                    "issue_key": matching_rule.issue_key,
                    "reason": matching_rule.description,
                    "expires": matching_rule.expires,
                }
            )
        elif signal.kind in {"github_permission"}:
            infra.append(item | {"reason": "CI/GitHub permission issue; not enough evidence for task autoreview."})
        else:
            actionable.append(item)

    if actionable:
        decision = "autoreview_required"
    elif infra and ignored:
        decision = "known_noise_or_infra_only"
    elif infra:
        decision = "ci_infra_blocked"
    else:
        decision = "known_noise_only"

    return {
        "ignored_known_noise": ignored,
        "non_actionable_failures": infra,
        "actionable_failures": actionable,
        "decision": decision,
    }


def classify_log(log_text: str, context: CheckContext) -> dict[str, Any]:
    signals = extract_failure_signals(log_text)
    if not signals and log_text.strip():
        snippet = "\n".join(strip_github_log_prefix(line) for line in log_text.splitlines()[-40:])
        signals = [FailureSignal(kind="unclassified_ci_failure", summary="Unclassified CI failure", detail=snippet)]
    return classify_signals(signals, context)


def run_json(command: list[str]) -> Any:
    proc = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(command)}\n{proc.stderr.strip()}")
    return json.loads(proc.stdout or "null")


def run_text(command: list[str]) -> str:
    proc = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(command)}\n{proc.stderr.strip()}")
    return proc.stdout


def get_pr_checks(owner: str, repo: str, pr_number: int) -> dict[str, Any]:
    return run_json(
        [
            "gh",
            "pr",
            "view",
            str(pr_number),
            "--repo",
            f"{owner}/{repo}",
            "--json",
            "number,title,url,headRefName,headRefOid,statusCheckRollup",
        ]
    )


def job_id_from_details_url(url: str | None) -> str | None:
    if not url:
        return None
    m = re.search(r"/actions/runs/\d+/job/(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/runs/(\d+)", url)
    if m:
        return m.group(1)
    return None


def fetch_check_log(owner: str, repo: str, check: dict[str, Any]) -> str:
    job_id = job_id_from_details_url(check.get("detailsUrl"))
    if not job_id:
        return ""
    try:
        return run_text(["gh", "api", f"repos/{owner}/{repo}/actions/jobs/{job_id}/logs"])
    except RuntimeError:
        # Some status contexts expose a run URL, not a job log URL. Keep the
        # analysis conservative rather than failing the whole scan.
        return ""


def is_secondary_test_report_check(context: CheckContext) -> bool:
    name = context.job_name or ""
    url = context.details_url or ""
    return bool(re.search(r"pytest results|test results", name, re.I)) and "/runs/" in url


def analyze_pr(pr_url: str) -> dict[str, Any]:
    owner, repo, number = parse_pr_url(pr_url)
    pr = get_pr_checks(owner, repo, number)
    head_sha = pr.get("headRefOid")
    failures: list[dict[str, Any]] = []
    checks = pr.get("statusCheckRollup") or []

    for check in checks:
        conclusion = str(check.get("conclusion") or check.get("state") or "").upper()
        status = str(check.get("status") or "").upper()
        if conclusion not in FAILURE_CHECK_CONCLUSIONS and status not in FAILURE_CHECK_CONCLUSIONS:
            continue
        context = CheckContext(
            repository=f"{owner}/{repo}",
            workflow_name=check.get("workflowName"),
            job_name=check.get("name") or check.get("context"),
            details_url=check.get("detailsUrl") or check.get("targetUrl"),
            head_sha=head_sha,
        )
        log_text = fetch_check_log(owner, repo, check)
        if log_text:
            classified = classify_log(log_text, context)
        elif is_secondary_test_report_check(context):
            classified = {
                "ignored_known_noise": [],
                "non_actionable_failures": [
                    {
                        "kind": "secondary_test_report_check",
                        "summary": f"Secondary test-report check failed: {context.job_name}",
                        "source": context.details_url,
                        "detail": "No standalone job log; primary test job carries the actionable failure.",
                        "fingerprint": hashlib.sha256((context.details_url or context.job_name or "secondary-report").encode()).hexdigest()[:16],
                    }
                ],
                "actionable_failures": [],
                "decision": "ci_infra_blocked",
            }
        else:
            classified = {
                "ignored_known_noise": [],
                "non_actionable_failures": [],
                "actionable_failures": [
                    {
                        "kind": "failed_check_without_log",
                        "summary": f"Failed check: {context.job_name}",
                        "source": context.details_url,
                        "detail": None,
                        "fingerprint": hashlib.sha256((context.details_url or context.job_name or "failed-check").encode()).hexdigest()[:16],
                    }
                ],
                "decision": "autoreview_required",
            }
        failures.append({"check": dataclasses.asdict(context), **classified})

    actionable = [f for failure in failures for f in failure["actionable_failures"]]
    ignored = [f for failure in failures for f in failure["ignored_known_noise"]]
    infra = [f for failure in failures for f in failure.get("non_actionable_failures", [])]
    decision = "green_or_no_failed_checks"
    if actionable:
        decision = "autoreview_required"
    elif ignored and infra:
        decision = "known_noise_or_infra_only"
    elif ignored:
        decision = "known_noise_only"
    elif infra:
        decision = "ci_infra_blocked"

    return {
        "pr": {
            "url": pr.get("url") or pr_url,
            "number": number,
            "title": pr.get("title"),
            "headRefName": pr.get("headRefName"),
            "headSha": head_sha,
            "repository": f"{owner}/{repo}",
        },
        "decision": decision,
        "failed_checks": failures,
        "ignored_known_noise_count": len(ignored),
        "non_actionable_failure_count": len(infra),
        "actionable_failure_count": len(actionable),
    }


def scan_paperclip_pull_requests(client: PaperclipClient) -> list[dict[str, Any]]:
    """Fetch active PR candidates from the company-scoped Paperclip API."""
    return client.list_candidates()


def _failure_fingerprint(analysis: dict[str, Any]) -> str:
    fingerprints = sorted(
        failure["fingerprint"]
        for check in analysis["failed_checks"]
        for failure in check.get("actionable_failures", [])
    )
    return hashlib.sha256("|".join(fingerprints).encode()).hexdigest()[:16]


def _report_payload(
    issue: dict[str, Any],
    analysis: dict[str, Any],
    disposition: str,
    failure_fingerprint: str,
) -> dict[str, Any]:
    pr = analysis["pr"]
    evidence: dict[str, Any] = {
        "decision": analysis["decision"],
        "failedChecks": analysis["failed_checks"],
    }
    candidate_head = issue.get("headSha")
    if isinstance(candidate_head, str) and candidate_head and candidate_head != pr["headSha"]:
        evidence["candidateHeadSha"] = candidate_head
    return {
        "issueId": issue["issueId"],
        "prUrl": issue.get("prUrl") or pr["url"],
        "repository": issue.get("repository") or pr["repository"],
        "prNumber": issue.get("prNumber") or pr["number"],
        "headSha": pr["headSha"],
        "fingerprint": failure_fingerprint,
        "disposition": disposition,
        "evidence": evidence,
    }


def enqueue_autoreview(
    issue: dict[str, Any],
    analysis: dict[str, Any],
    *,
    client: PaperclipClient | None = None,
    dry_run: bool = True,
    failure_fingerprint: str | None = None,
) -> dict[str, Any]:
    """Build and optionally submit one failed or passed CI report."""
    decision = analysis["decision"]
    if decision not in {"autoreview_required", "green_or_no_failed_checks"}:
        return {"queued": False, "reason": decision}
    if "issueId" not in issue:
        raise ValueError("A Paperclip issue id is required for CI report submission")
    if not isinstance(analysis["pr"].get("headSha"), str) or not analysis["pr"]["headSha"]:
        raise ValueError("GitHub PR analysis did not return a head SHA")

    disposition = "failed" if decision == "autoreview_required" else "passed"
    fingerprint = failure_fingerprint or issue.get("failureFingerprint")
    if disposition == "failed":
        fingerprint = _failure_fingerprint(analysis)
    if not isinstance(fingerprint, str) or not fingerprint:
        return {"queued": False, "reason": "green_report_requires_fingerprint", "dry_run": dry_run}
    report = _report_payload(issue, analysis, disposition, fingerprint)
    idempotency_key = f"github-ci-autoreview:{report['issueId']}:{report['headSha']}:{fingerprint}"
    result: dict[str, Any] = {
        "queued": False,
        "dry_run": dry_run,
        "idempotency_key": idempotency_key,
        "payload": report,
    }
    if dry_run:
        return result
    if client is None:
        raise ConfigurationError("Paperclip API client is required when --enqueue is set")
    result["server_response"] = client.send_report(report)
    result["queued"] = True
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr-url", help="Analyze a single GitHub PR URL")
    parser.add_argument("--issue-id", help="Explicit Paperclip issue id for --pr-url report mode")
    parser.add_argument("--failure-fingerprint", help="Existing CI failure fingerprint for a passed report")
    parser.add_argument("--scan-paperclip", action="store_true", help="Fetch active PR candidates from Paperclip")
    parser.add_argument("--enqueue", action="store_true", help="Submit Paperclip CI reports. Default is dry-run.")
    parser.add_argument("--api-base", help="Paperclip server base URL (or PAPERCLIP_API_BASE/PAPERCLIP_API_URL)")
    parser.add_argument("--api-key", help="Paperclip bearer API key (or PAPERCLIP_API_KEY)")
    parser.add_argument("--company-id", help="Paperclip company id (or PAPERCLIP_COMPANY_ID)")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument("--quiet", action="store_true", help="Only print PRs that queued an autoreview or require action")
    args = parser.parse_args(argv)

    if not args.pr_url and not args.scan_paperclip:
        parser.error("use --pr-url or --scan-paperclip")
    if args.enqueue and args.pr_url and not args.issue_id:
        parser.error("--enqueue with --pr-url requires --issue-id")
    if args.scan_paperclip and args.failure_fingerprint:
        parser.error("--failure-fingerprint is only valid with --pr-url")

    client: PaperclipClient | None = None
    try:
        if args.scan_paperclip or args.enqueue:
            client = PaperclipClient(resolve_paperclip_config(args.api_base, args.api_key, args.company_id))
    except ConfigurationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    results: list[dict[str, Any]] = []
    if args.pr_url:
        try:
            analysis = analyze_pr(args.pr_url)
            issue = None
            enqueue = None
            if args.issue_id:
                owner, repo, number = parse_pr_url(args.pr_url)
                issue = {
                    "issueId": args.issue_id,
                    "prUrl": args.pr_url,
                    "repository": f"{owner}/{repo}",
                    "prNumber": number,
                }
                enqueue = enqueue_autoreview(
                    issue,
                    analysis,
                    client=client,
                    dry_run=not args.enqueue,
                    failure_fingerprint=args.failure_fingerprint,
                )
            results.append({"issue": issue, "analysis": analysis, "enqueue": enqueue})
        except (ConfigurationError, PaperclipApiError, RuntimeError, ValueError, KeyError, TypeError, AttributeError) as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1

    if args.scan_paperclip:
        if client is None:
            print("ERROR: Paperclip API client is required for --scan-paperclip", file=sys.stderr)
            return 1
        try:
            issues = scan_paperclip_pull_requests(client)
        except PaperclipApiError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        had_error = False
        for issue in issues:
            try:
                analysis = analyze_pr(issue["prUrl"])
                enqueue = enqueue_autoreview(
                    issue,
                    analysis,
                    client=client,
                    dry_run=not args.enqueue,
                )
            except (ConfigurationError, PaperclipApiError, RuntimeError, ValueError, KeyError, TypeError, AttributeError) as exc:
                had_error = True
                identifier = issue.get("issueIdentifier", "unknown issue")
                print(
                    f"WARNING: {identifier}: skipping invalid/unavailable PR {issue.get('prUrl')}: {exc}",
                    file=sys.stderr,
                )
                continue
            results.append({"issue": issue, "analysis": analysis, "enqueue": enqueue})
        if had_error:
            exit_code = 1
        else:
            exit_code = 0
    else:
        exit_code = 0

    if args.json:
        if args.quiet:
            results = [
                item
                for item in results
                if item["analysis"]["decision"] == "autoreview_required"
                or (item.get("enqueue") or {}).get("queued")
            ]
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        for item in results:
            if args.quiet and item["analysis"]["decision"] != "autoreview_required" and not (item.get("enqueue") or {}).get("queued"):
                continue
            issue = item.get("issue") or {}
            analysis = item["analysis"]
            pr = analysis["pr"]
            label = f"{issue.get('issueIdentifier', 'PR')} {pr['url']}"
            print(f"{label}: {analysis['decision']} ({analysis['actionable_failure_count']} actionable, {analysis['ignored_known_noise_count']} ignored, {analysis.get('non_actionable_failure_count', 0)} infra/non-actionable)")
            for check in analysis["failed_checks"]:
                check_name = check["check"].get("job_name") or check["check"].get("details_url")
                for noise in check.get("ignored_known_noise", []):
                    print(f"  ignored [{noise['issue_key']}]: {check_name}: {noise['summary']}")
                for failure in check.get("actionable_failures", []):
                    print(f"  ACTION: {check_name}: {failure['summary']}")
                for failure in check.get("non_actionable_failures", []):
                    print(f"  infra: {check_name}: {failure['summary']}")
            if item.get("enqueue"):
                print("  enqueue:", json.dumps(item["enqueue"], ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
