"""Outage recovery tests use only synthetic GitHub and Worker responses."""

from contextlib import redirect_stdout, redirect_stderr
import copy
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import ccm_recover as recovery
from ccm_deploy import DeployError


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        value = self.responses[path]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.attempt = {'attemptId': '123-2', 'revision': 7, 'authorized': True}
        self.prefix = '/repos/owner/repo/actions/runs/123/attempts/2'
        self.run = {'id': 123, 'run_attempt': 2, 'head_branch': 'main', 'event': 'workflow_dispatch',
                    'repository': {'full_name': 'owner/repo'}, 'head_sha': 'a' * 40,
                    'path': '.github/workflows/deploy.yml',
                    'status': 'completed', 'conclusion': 'failure'}
        self.job = {'id': 44, 'run_id': 123, 'run_attempt': 2, 'head_sha': 'a' * 40,
                    'head_branch': 'main', 'status': 'completed', 'steps': [
            {'name': recovery.PREPARE_STEP, 'status': 'completed', 'conclusion': 'success'},
            {'name': recovery.DEPLOY_STEP, 'status': 'completed', 'conclusion': 'success'},
            {'name': 'Record exact attempt result in D1', 'status': 'completed', 'conclusion': 'failure'},
        ]}
        self.jobs = {'total_count': 1, 'jobs': [self.job]}
        self.github = FakeClient({self.prefix: self.run, self.prefix + '/jobs?per_page=100': self.jobs})
        self.api = FakeClient({'/v1/deployments/active': {'attempt': self.attempt},
                              '/v1/deployments/123-2/recover': {'recovered': True, 'attemptId': '123-2', 'revision': 7}})
        self.env = {'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '456', 'GITHUB_RUN_ATTEMPT': '1'}
        self.out = io.StringIO()
        self.output = redirect_stdout(self.out)
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def test_lost_callback_recovers_terminal_pages_then_requires_new_publication(self):
        recovery.recover(self.env, self.api, self.github)
        self.assertEqual(self.api.calls[-1], ('POST', '/v1/deployments/123-2/recover', {
            'runId': '123', 'runAttempt': 2, 'runConclusion': 'failure', 'pagesConclusion': 'success'}))
        self.assertNotIn('verified', self.out.getvalue())
        self.assertEqual(self.github.calls[0][1], self.prefix)

    def test_cancelled_before_pages_is_safe_only_with_explicit_skipped_step(self):
        self.run['conclusion'] = 'cancelled'
        self.job['steps'][1]['conclusion'] = 'skipped'
        recovery.recover(self.env, self.api, self.github)
        self.assertEqual(self.api.calls[-1][2]['pagesConclusion'], 'not_started')

    def test_failed_cancelled_or_unfinished_pages_stays_locked(self):
        for conclusion in ('failure', 'cancelled', None):
            with self.subTest(conclusion=conclusion):
                self.job['steps'][1]['conclusion'] = conclusion
                with self.assertRaisesRegex(DeployError, 'pages_termination_unknown'):
                    recovery.recover(self.env, self.api, self.github)
        self.assertTrue(all(method == 'GET' for method, _, _ in self.api.calls))

    def test_running_prior_workflow_is_not_recovered_even_if_pages_step_succeeded(self):
        self.run['status'] = 'in_progress'
        with self.assertRaisesRegex(DeployError, 'prior_run_not_terminal'):
            recovery.recover(self.env, self.api, self.github)
        self.assertEqual(len(self.github.calls), 1)

    def test_wrong_run_attempt_branch_or_event_is_rejected(self):
        for key, value in (('id', 456), ('run_attempt', 3), ('head_branch', 'feature'), ('event', 'pull_request'),
                           ('repository', {'full_name': 'other/repo'}), ('head_sha', 'invalid'),
                           ('path', '.github/workflows/unrelated.yml')):
            previous = self.run[key]
            self.run[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(DeployError, 'prior_run_not_terminal'):
                recovery.recover(self.env, self.api, self.github)
            self.run[key] = previous

    def test_same_run_new_attempt_recovers_only_old_attempt_not_current_sha(self):
        self.env.update(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='3', GITHUB_SHA='b' * 40)
        recovery.recover(self.env, self.api, self.github)
        self.assertEqual(self.github.calls[0][1], self.prefix)
        self.assertEqual(self.api.calls[-1][2]['runAttempt'], 2)

    def test_job_must_belong_to_exact_run_attempt_commit_and_main(self):
        for key, value in (('run_id', 999), ('run_attempt', 3), ('head_sha', 'b' * 40), ('head_branch', 'feature')):
            previous = self.job[key]
            self.job[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(DeployError, 'prior_publisher_not_terminal'):
                recovery.recover(self.env, self.api, self.github)
            self.job[key] = previous

    def test_scheduled_reusable_job_is_identified_by_protocol_steps(self):
        self.run.update(event='schedule', path='.github/workflows/maintenance.yml')
        self.job['name'] = 'publish / deploy'
        self.jobs['jobs'].insert(0, {'id': 43, 'run_id': 123, 'status': 'completed', 'steps': [
            {'name': 'Refresh due works and apply retention policy', 'status': 'completed', 'conclusion': 'success'}]})
        self.jobs['total_count'] = 2
        recovery.recover(self.env, self.api, self.github)
        self.assertEqual(self.api.calls[-1][2]['pagesConclusion'], 'success')

    def test_missing_or_duplicate_pages_step_is_not_evidence_of_no_deploy(self):
        original = list(self.job['steps'])
        self.job['steps'] = [self.job['steps'][0]]
        with self.assertRaisesRegex(DeployError, 'pages_termination_unknown'):
            recovery.recover(self.env, self.api, self.github)
        self.job['steps'] = original + [copy.deepcopy(original[1])]
        with self.assertRaisesRegex(DeployError, 'pages_termination_unknown'):
            recovery.recover(self.env, self.api, self.github)

    def test_paginated_or_ambiguous_publisher_jobs_fail_closed(self):
        self.jobs['total_count'] = 2
        with self.assertRaisesRegex(DeployError, 'incomplete_prior_jobs'):
            recovery.recover(self.env, self.api, self.github)
        self.jobs['jobs'].append(copy.deepcopy(self.job))
        with self.assertRaisesRegex(DeployError, 'ambiguous_prior_publisher'):
            recovery.recover(self.env, self.api, self.github)

    def test_unknown_or_unreadable_github_evidence_never_unlocks(self):
        self.github.responses[self.prefix] = DeployError('api_unreachable')
        with self.assertRaisesRegex(DeployError, 'api_unreachable'):
            recovery.recover(self.env, self.api, self.github)
        self.assertEqual(len(self.api.calls), 1)

    def test_invalid_recovery_response_does_not_report_success(self):
        self.api.responses['/v1/deployments/123-2/recover']['revision'] = 8
        with self.assertRaisesRegex(DeployError, 'invalid_recovery_response'):
            recovery.recover(self.env, self.api, self.github)
        self.assertEqual(self.out.getvalue(), '')

    def test_current_attempt_and_unauthorized_pages_success_are_rejected(self):
        self.env.update(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='2')
        with self.assertRaisesRegex(DeployError, 'cannot_recover_current_attempt'):
            recovery.recover(self.env, self.api, self.github)
        self.env.update(GITHUB_RUN_ID='456', GITHUB_RUN_ATTEMPT='1')
        self.attempt['authorized'] = False
        with self.assertRaisesRegex(DeployError, 'pages_termination_unknown'):
            recovery.recover(self.env, self.api, self.github)

    def test_no_lock_needs_no_github_credentials_or_network(self):
        self.api.responses['/v1/deployments/active']['attempt'] = None
        recovery.recover({}, self.api, self.github)
        self.assertEqual(self.github.calls, [])

    def test_cli_never_logs_unexpected_exception_data(self):
        err = io.StringIO()
        with patch.object(recovery, 'recover', side_effect=RuntimeError('secret token and title')), redirect_stderr(err):
            self.assertEqual(recovery.main(), 1)
        self.assertNotIn('secret token', err.getvalue())


if __name__ == '__main__':
    unittest.main()
