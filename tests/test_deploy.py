"""Synthetic deployment tests: no live API, GitHub, D1, or YouTube calls."""

from contextlib import redirect_stderr, redirect_stdout
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


SPEC = importlib.util.spec_from_file_location("ccm_deploy", Path(__file__).resolve().parents[1] / "scripts" / "ccm_deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def publication(revision=7):
    return {"revision": revision,
            "libraryJson": '{"version":1,"movies":[{"id":"movie_1","title":"合成作品",'
                           '"genre":"映画","url":"https://www.youtube.com/watch?v=SYNTHETIC01"}]}\n',
            "queueJson": '{ "version": 1, "queue": [{"id":"queue_1","movieId":"movie_1"}] }\n'}


class FakeApi:
    def __init__(self):
        self.publication = publication()
        self.calls = []
        self.failures = {}
        self.responses = {}

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if path in self.failures:
            raise self.failures[path]
        if path in self.responses:
            return copy.deepcopy(self.responses[path])
        if path == "/v1/publication":
            return copy.deepcopy(self.publication)
        if path == "/v1/deployments/begin":
            return {"attemptId": body["attemptId"], "revision": body["expectedRevision"]}
        if path.endswith("/authorize"):
            return {"authorized": True, "revision": self.publication["revision"]}
        if path.endswith("/finish"):
            return {"outcome": body["outcome"], "revision": 7}
        raise AssertionError("unexpected fake call")


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        # Keep test scratch in the writable checkout; some Windows sandboxes
        # cannot create child directories below the OS-provided temp location.
        test_root = Path(__file__).resolve().parents[1]
        self.temporary = tempfile.TemporaryDirectory(prefix=".deploy-test-", dir=test_root)
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.cwd = root / "checkout"
        self.cwd.mkdir()
        self.env = {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2", "RUNNER_TEMP": str(root / "runner-temp"),
                    "CCM_API_BASE_URL": "https://example.invalid", "CCM_DEPLOY_TOKEN": "secret-marker",
                    "PAGE_URL": "https://example.github.io/cinema/"}
        self.api = FakeApi()
        self.sleeps = []
        self.output = io.StringIO()
        self.stdout = redirect_stdout(self.output)
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)
        self.runner = self.make_runner()

    def make_runner(self, public_fetch=None):
        return deploy.DeploymentRunner(self.env, self.cwd, self.api, public_fetch, self.sleeps.append)

    def prepare_authorize(self):
        self.runner.prepare()
        self.runner.authorize()

    def finish_body(self):
        return self.api.calls[-1][2]

    def test_prepare_preserves_utf8_bytes_and_keeps_context_out_of_artifact(self):
        self.runner.prepare()
        self.assertEqual((self.cwd / "library.json").read_bytes(), self.api.publication["libraryJson"].encode())
        self.assertEqual((self.cwd / "queue.json").read_bytes(), self.api.publication["queueJson"].encode())
        self.assertEqual(sorted(path.name for path in self.cwd.iterdir()), ["library.json", "queue.json"])
        private_text = self.runner.context_path.read_text()
        self.assertNotIn("secret-marker", private_text)
        self.assertNotIn("SYNTHETIC01", private_text)
        self.assertNotIn("合成作品", private_text)
        self.assertEqual(self.api.calls[-1][2], {"attemptId": "123-2", "expectedRevision": 7})

    def test_context_inside_checkout_is_rejected(self):
        self.env["RUNNER_TEMP"] = str(self.cwd / "tmp")
        with self.assertRaisesRegex(deploy.DeployError, "context_inside_artifact"):
            self.make_runner()

    def test_old_requested_revision_never_acquires_lock(self):
        self.env["REQUESTED_REVISION"] = "6"
        runner = self.make_runner()
        with self.assertRaisesRegex(deploy.DeployError, "requested_revision_superseded"):
            runner.prepare()
        self.assertEqual(len(self.api.calls), 1)
        self.assertFalse(runner.context_path.exists())
        self.assertFalse((self.cwd / "library.json").exists())

    def test_requested_revision_is_data_not_shell_or_sql(self):
        self.env["REQUESTED_REVISION"] = "$(echo secret)"
        with self.assertRaisesRegex(deploy.DeployError, "invalid_requested_revision"):
            self.make_runner().prepare()
        self.assertEqual(self.api.calls, [])

    def test_begin_response_loss_still_leaves_attempt_for_finalizer(self):
        self.api.failures["/v1/deployments/begin"] = deploy.DeployError("api_unreachable")
        with self.assertRaises(deploy.DeployError):
            self.runner.prepare()
        self.runner.env.update(DEPLOY_OUTCOME="skipped", VERIFY_OUTCOME="skipped")
        self.runner.finish()
        self.assertEqual(self.api.calls[-1][1], "/v1/deployments/123-2/finish")
        self.assertEqual(self.finish_body()["outcome"], "failed")
        self.assertEqual(self.finish_body()["errorCode"], "prepare_failed")

    def test_revision_recheck_rejects_stale_snapshot_and_records_superseded(self):
        self.runner.prepare()
        path = "/v1/deployments/123-2/authorize"
        self.api.failures[path] = deploy.DeployError("api_http_409", 409)
        with self.assertRaises(deploy.DeployError):
            self.runner.authorize()
        self.runner.env.update(DEPLOY_OUTCOME="skipped", VERIFY_OUTCOME="skipped")
        self.runner.finish()
        self.assertFalse(self.runner.load()["authorized"])
        self.assertEqual(self.finish_body(), {"outcome": "superseded", "deployed": False,
                                             "libraryMatches": False, "queueMatches": False,
                                             "phase": "authorize", "retryCount": 0,
                                             "errorCode": "revision_changed"})

    def test_failed_recheck_fails_closed(self):
        self.runner.prepare()
        self.api.failures["/v1/deployments/123-2/authorize"] = deploy.DeployError("api_unreachable")
        with self.assertRaises(deploy.DeployError):
            self.runner.authorize()
        self.runner.env.update(DEPLOY_OUTCOME="skipped", VERIFY_OUTCOME="skipped")
        self.runner.finish()
        self.assertEqual(self.finish_body()["outcome"], "failed")
        self.assertEqual(self.finish_body()["errorCode"], "revision_check_failed")

    def test_malformed_authorization_response_does_not_allow_verification(self):
        self.runner.prepare()
        self.api.responses["/v1/deployments/123-2/authorize"] = {"authorized": True, "revision": 8}
        with self.assertRaisesRegex(deploy.DeployError, "invalid_authorization_response"):
            self.runner.authorize()
        with self.assertRaisesRegex(deploy.DeployError, "attempt_not_authorized"):
            self.runner.verify()

    def test_verification_requires_both_files_and_records_exact_attempt(self):
        self.prepare_authorize()
        def fetch(url):
            name = "libraryJson" if url.endswith("library.json") else "queueJson"
            return self.api.publication[name].encode()
        self.runner.public_fetch = fetch
        self.runner.verify()
        self.assertEqual(self.sleeps, [120])
        self.runner.env.update(DEPLOY_OUTCOME="success", VERIFY_OUTCOME="success")
        # A newer current snapshot must not change the completed attempt's target.
        self.api.publication["revision"] = 8
        self.runner.finish()
        self.assertEqual(self.api.calls[-1][1], "/v1/deployments/123-2/finish")
        self.assertEqual(self.runner.load()["revision"], 7)
        self.assertEqual(self.finish_body()["outcome"], "verified")
        self.assertNotIn("errorCode", self.finish_body())

    def test_partial_match_retries_then_records_failed(self):
        self.prepare_authorize()
        self.runner.public_fetch = lambda url: (self.api.publication["libraryJson"].encode()
                                               if url.endswith("library.json") else b'{"version":1,"queue":[]}')
        with self.assertRaisesRegex(deploy.DeployError, "public_content_mismatch"):
            self.runner.verify()
        self.assertEqual(self.sleeps, [120, 480, 1200])
        self.runner.env.update(DEPLOY_OUTCOME="success", VERIFY_OUTCOME="failure")
        self.runner.finish()
        body = self.finish_body()
        self.assertEqual(body["outcome"], "failed")
        self.assertEqual(body["retryCount"], 2)
        self.assertTrue(body["libraryMatches"])
        self.assertFalse(body["queueMatches"])
        self.assertEqual(body["errorCode"], "verification_failed")

    def test_late_verified_completion_accepts_superseded_for_exact_target_only(self):
        self.prepare_authorize()
        self.runner.public_fetch = lambda url: self.api.publication[
            "libraryJson" if url.endswith("library.json") else "queueJson"].encode()
        self.runner.verify(delays=(0,))
        self.runner.env.update(DEPLOY_OUTCOME="success", VERIFY_OUTCOME="success")
        path = "/v1/deployments/123-2/finish"
        self.api.responses[path] = {"outcome": "superseded", "revision": 8}
        with self.assertRaisesRegex(deploy.DeployError, "invalid_finish_response"):
            self.runner.finish()
        self.assertFalse(self.runner.load().get("finishRecorded", False))
        self.api.responses[path] = {"outcome": "superseded", "revision": 7}
        self.runner.finish()
        context = self.runner.load()
        self.assertTrue(context["finishRecorded"])
        self.assertEqual(context["recordedOutcome"], "superseded")
        self.assertEqual(context["finishPayload"]["outcome"], "verified")
        self.assertEqual(context["revision"], 7)
        self.assertIn("deployment_result_recorded outcome=superseded", self.output.getvalue())

    def test_failed_result_cannot_be_reclassified_verified_by_callback_response(self):
        self.runner.prepare()
        self.runner.env.update(DEPLOY_OUTCOME="skipped", VERIFY_OUTCOME="skipped")
        self.api.responses["/v1/deployments/123-2/finish"] = {"outcome": "verified", "revision": 7}
        with self.assertRaisesRegex(deploy.DeployError, "invalid_finish_response"):
            self.runner.finish()

    def test_fetch_failure_is_sanitized(self):
        self.prepare_authorize()
        def fail(url):
            raise deploy.DeployError("public_fetch_failed")
        self.runner.public_fetch = fail
        with self.assertRaises(deploy.DeployError):
            self.runner.verify(delays=(0,))
        self.runner.env.update(DEPLOY_OUTCOME="success", VERIFY_OUTCOME="failure")
        self.runner.finish()
        self.assertEqual(self.finish_body()["errorCode"], "public_fetch_failed")

    def test_deployment_failure_is_uncertain_not_a_safe_unlock(self):
        self.prepare_authorize()
        self.runner.env.update(DEPLOY_OUTCOME="failure", VERIFY_OUTCOME="skipped")
        self.runner.finish()
        self.assertEqual(self.finish_body()["outcome"], "uncertain")
        self.assertEqual(self.finish_body()["errorCode"], "deployment_unknown")

    def test_cancelled_or_unknown_deployment_is_uncertain(self):
        for result in ("cancelled", ""):
            with self.subTest(result=result):
                self.prepare_authorize()
                self.runner.env.update(DEPLOY_OUTCOME=result, VERIFY_OUTCOME="skipped")
                self.runner.finish()
                self.assertEqual(self.finish_body()["outcome"], "uncertain")
                self.runner.context_path.unlink()

    def test_artifact_failure_is_recorded_without_deploy(self):
        self.runner.prepare()
        self.runner.env.update(ARTIFACT_OUTCOME="failure", DEPLOY_OUTCOME="skipped", VERIFY_OUTCOME="skipped")
        self.runner.finish()
        self.assertEqual(self.finish_body()["phase"], "prepare")
        self.assertEqual(self.finish_body()["errorCode"], "artifact_failed")

    def test_result_write_failure_is_not_success_and_replays_identical_payload(self):
        self.prepare_authorize()
        self.runner.env.update(DEPLOY_OUTCOME="failure", VERIFY_OUTCOME="skipped")
        path = "/v1/deployments/123-2/finish"
        self.api.failures[path] = deploy.DeployError("api_unreachable")
        with self.assertRaises(deploy.DeployError):
            self.runner.finish()
        payload = copy.deepcopy(self.finish_body())
        self.assertFalse(self.runner.load().get("finishRecorded", False))
        del self.api.failures[path]
        self.runner.env.update(DEPLOY_OUTCOME="success", VERIFY_OUTCOME="success")
        self.runner.finish()
        self.assertEqual(self.finish_body(), payload)
        self.assertTrue(self.runner.load()["finishRecorded"])

    def test_no_attempt_has_nothing_to_finish(self):
        self.runner.finish()
        self.assertEqual(self.api.calls, [])

    def test_malformed_snapshot_never_acquires_lock(self):
        malformed = publication()
        lib = json.loads(malformed["libraryJson"])
        lib["movies"][0]["privateMemo"] = "must not publish"
        malformed["libraryJson"] = json.dumps(lib)
        self.api.publication = malformed
        with self.assertRaisesRegex(deploy.DeployError, "invalid_public_json"):
            self.runner.prepare()
        self.assertEqual(len(self.api.calls), 1)


class ValidationTests(unittest.TestCase):
    def test_api_request_identifies_ccm_and_keeps_bearer_authentication(self):
        captured = {}
        class Opener:
            def open(self, request, timeout):
                captured.update(request=request, timeout=timeout)
                return io.BytesIO(b'{"revision":7}')
        client = deploy.ApiClient("https://example.invalid", "synthetic-token", Opener())
        result = client.request("GET", "/v1/state")
        request = captured["request"]
        self.assertEqual(request.get_header("User-agent"),
                         "CCM-Publication/0.1 (+https://github.com/qiqiqiqiqiq/cinema-catalog-manager)")
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-token")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(captured["timeout"], 30)
        self.assertEqual(result, {"revision": 7})

    def test_public_fetch_identifies_ccm_without_forwarding_authentication(self):
        captured = {}
        class Opener:
            def open(self, request, timeout):
                captured.update(request=request, timeout=timeout)
                return io.BytesIO(b'{"version":1,"movies":[]}')
        with patch.object(deploy.urllib.request, "build_opener", return_value=Opener()) as build:
            result = deploy.fetch_public("https://example.github.io/cinema/library.json")
        request = captured["request"]
        self.assertEqual(request.get_header("User-agent"),
                         "CCM-Publication/0.1 (+https://github.com/qiqiqiqiqiq/cinema-catalog-manager)")
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(captured["timeout"], 30)
        self.assertIsInstance(build.call_args.args[0], deploy.NoRedirect)
        self.assertEqual(result, b'{"version":1,"movies":[]}')

    def test_allowlist_referential_integrity_and_duplicate_keys(self):
        bad_publications = []
        duplicate_movie = publication()
        lib = json.loads(duplicate_movie["libraryJson"])
        lib["movies"].append(copy.deepcopy(lib["movies"][0]))
        duplicate_movie["libraryJson"] = json.dumps(lib)
        bad_publications.append(duplicate_movie)
        orphan = publication()
        orphan["queueJson"] = '{"version":1,"queue":[{"id":"q","movieId":"missing"}]}'
        bad_publications.append(orphan)
        duplicate_field = publication()
        duplicate_field["queueJson"] = '{"version":1,"queue":[{"private":"hidden"}],"queue":[]}'
        bad_publications.append(duplicate_field)
        wrong_version = publication()
        wrong_version["queueJson"] = '{"version":true,"queue":[]}'
        bad_publications.append(wrong_version)
        for item in bad_publications:
            with self.subTest(item=item), self.assertRaises(deploy.DeployError):
                deploy.validate_publication(item)

    def test_api_http_error_never_reads_or_exposes_body(self):
        secret_body = io.BytesIO(b'private-title secret-token')
        error = urllib.error.HTTPError("https://example.invalid/secret", 403, "private-title", {}, secret_body)
        class Opener:
            def open(self, request, timeout):
                raise error
        client = deploy.ApiClient("https://example.invalid", "token", Opener())
        with self.assertRaisesRegex(deploy.DeployError, "api_http_403") as caught:
            client.request("GET", "/v1/state")
        self.assertEqual(secret_body.tell(), 0)
        self.assertNotIn("private-title", str(caught.exception))

    def test_api_rejects_insecure_or_embedded_credentials(self):
        for url in ("http://example.invalid", "https://user:password@example.invalid", "https://example.invalid/?token=x"):
            with self.subTest(url=url), self.assertRaises(deploy.DeployError):
                deploy.ApiClient(url, "token")

    def test_cli_masks_unexpected_exception_messages(self):
        stderr = io.StringIO()
        with patch.object(deploy, "DeploymentRunner", side_effect=RuntimeError("secret-token private-title")), redirect_stderr(stderr):
            status = deploy.main(["prepare"])
        self.assertEqual(status, 1)
        self.assertNotIn("secret-token", stderr.getvalue())
        self.assertNotIn("private-title", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
