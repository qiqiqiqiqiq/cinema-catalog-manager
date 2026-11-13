import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from ccm_deploy import DeployError
from ccm_maintenance import MaintenanceRunner


class FakeApi:
    def __init__(self):
        self.pending = [['movie_1'], ['movie_2']]
        self.mode = 'ok'
        self.calls = []
        self.finished = None
        self.deleted = False
        self.finish_error = False
        self.closed = None

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path.endswith('/runs/start'):
            return {'status': self.closed or 'running'}
        if path.endswith('/plan'):
            return {'workIds': self.pending[0] if self.pending else [], 'dueCount': sum(map(len, self.pending))}
        if path.endswith('/metadata/refresh'):
            if self.mode == 'quota':
                raise DeployError('api_http_429', 429)
            batch = self.pending.pop(0)
            if self.mode == 'lost_response':
                raise DeployError('api_unreachable')
            return {'refresh': {'ok': len(batch) if self.mode == 'ok' else 0,
                    'unavailable': 0, 'apiError': len(batch) if self.mode != 'ok' else 0}}
        if path == '/v1/state':
            return {'generation': 2, 'revision': 3, 'needsDeployment': True, 'activeAttemptId': None}
        if path.endswith('/delete-eligible'):
            self.deleted = True
            return {'removedCount': 1}
        if path.endswith('/finish'):
            if self.finish_error:
                raise DeployError('api_unreachable')
            self.finished = body
            return {'status': body['outcome']}
        raise AssertionError(path)


class MaintenanceTests(unittest.TestCase):
    def run_job(self, api, max_batches=100):
        with tempfile.TemporaryDirectory() as temp, redirect_stdout(io.StringIO()):
            output = Path(temp) / 'outputs'
            runner = MaintenanceRunner({'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
                                        'GITHUB_OUTPUT': str(output)}, api=api, max_batches=max_batches)
            result = runner.run()
            return result, output.read_text()

    def test_success_batches_and_d1_finish_with_counts_and_publication_output(self):
        api = FakeApi()
        result, output = self.run_job(api)
        self.assertEqual(result, 0)
        self.assertTrue(api.deleted)
        self.assertEqual(api.finished['counts']['ok'], 2)
        self.assertEqual(api.finished['counts']['deleted'], 1)
        self.assertIn('needs_deployment=true', output)

    def test_errors_do_not_starve_later_batches_and_deletion_still_runs(self):
        api = FakeApi(); api.mode = 'error'
        result, output = self.run_job(api)
        self.assertEqual(result, 1)
        self.assertEqual(api.finished['counts']['apiError'], 2)
        self.assertEqual(api.finished['errorCode'], 'api_error')
        self.assertEqual(api.pending, [])
        self.assertTrue(api.deleted)
        self.assertIn('needs_deployment=true', output)

    def test_quota_failure_still_deletes_and_requests_pending_publication(self):
        api = FakeApi(); api.mode = 'quota'
        result, output = self.run_job(api)
        self.assertEqual(result, 1)
        self.assertEqual(api.finished['errorCode'], 'api_budget_exhausted')
        self.assertTrue(api.deleted)
        self.assertIn('revision=3', output)

    def test_lost_refresh_response_resumes_from_new_d1_plan_without_reprocessing_committed_batch(self):
        api = FakeApi(); api.mode = 'lost_response'
        self.assertEqual(self.run_job(api)[0], 1)
        self.assertEqual(api.pending, [['movie_2']])
        api.mode = 'ok'
        self.assertEqual(self.run_job(api)[0], 0)
        refreshed = [call[2]['workIds'] for call in api.calls if call[1].endswith('/metadata/refresh')]
        self.assertEqual(refreshed, [['movie_1'], ['movie_2']])

    def test_capacity_failure_publishes_committed_changes_and_exact_capacity_succeeds(self):
        api = FakeApi()
        self.assertEqual(self.run_job(api, max_batches=1)[0], 1)
        self.assertEqual(api.finished['errorCode'], 'batch_limit')
        api = FakeApi()
        self.assertEqual(self.run_job(api, max_batches=2)[0], 0)

    def test_finish_failure_fails_job_after_preserving_deployment_output(self):
        api = FakeApi(); api.finish_error = True
        with self.assertRaises(DeployError):
            self.run_job(api)
        self.assertTrue(api.deleted)

    def test_finished_run_replay_does_not_repeat_mutations(self):
        api = FakeApi(); api.closed = 'success'
        self.assertEqual(self.run_job(api)[0], 0)
        self.assertFalse(api.deleted)
        self.assertFalse(any(c[1].endswith('/metadata/refresh') for c in api.calls))

    def test_malformed_plan_fails_closed_but_still_checks_retention(self):
        api = FakeApi(); api.pending = [[{'not': 'an id'}]]
        result, _ = self.run_job(api)
        self.assertEqual(result, 1)
        self.assertEqual(api.finished['errorCode'], 'invalid_response')
        self.assertTrue(api.deleted)


if __name__ == '__main__':
    unittest.main()
