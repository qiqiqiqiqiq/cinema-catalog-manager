#!/usr/bin/env python3
"""Resumable maintenance: D1 timestamps are the cursor; no API bodies on disk."""
import os
from pathlib import Path
import re
import sys

from ccm_deploy import ApiClient, DeployError


class MaintenanceRunner:
    def __init__(self, env=None, api=None, max_batches=100):
        self.env = dict(os.environ if env is None else env)
        self.run_id = self.env.get('GITHUB_RUN_ID', '') + '-' + self.env.get('GITHUB_RUN_ATTEMPT', '')
        if not re.fullmatch(r'[0-9]{1,24}-[0-9]{1,8}', self.run_id):
            raise DeployError('invalid_run_identity')
        self.api = api or ApiClient(self.env.get('CCM_API_BASE_URL', ''), self.env.get('CCM_MAINTENANCE_TOKEN', ''))
        self.max_batches = max_batches

    def output_state(self):
        state = self.api.request('GET', '/v1/state')
        if (type(state.get('revision')) is not int or state['revision'] < 0 or
                type(state.get('needsDeployment')) is not bool or
                (state.get('activeAttemptId') is not None and not isinstance(state['activeAttemptId'], str))):
            raise DeployError('invalid_response')
        output = self.env.get('GITHUB_OUTPUT')
        if output:
            with Path(output).open('a', encoding='utf-8') as stream:
                stream.write('revision=' + str(state['revision']) + '\n')
                stream.write('needs_deployment=' + str(state['needsDeployment'] or bool(state.get('activeAttemptId'))).lower() + '\n')
        return state

    @staticmethod
    def code(error):
        if isinstance(error, DeployError):
            if error.status == 429:
                return 'api_budget_exhausted'
            if error.status == 409:
                return 'revision_conflict'
            if error.code in {'api_unreachable', 'batch_limit', 'invalid_response'}:
                return error.code
        return 'request_failed'

    def run(self):
        started = self.api.request('POST', '/v1/maintenance/runs/start', {'runId': self.run_id})
        if started.get('status') != 'running':
            self.output_state()
            return 0 if started.get('status') == 'success' else 1
        error_code = None
        counts = dict.fromkeys(['batches', 'ok', 'unavailable', 'apiError', 'deleted', 'refreshRequests'], 0)
        try:
            for _ in range(self.max_batches):
                plan = self.api.request('GET', '/v1/maintenance/plan')
                ids = plan.get('workIds')
                if (not isinstance(ids, list) or len(ids) > 50 or
                        any(not isinstance(i, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', i) for i in ids) or
                        len(set(ids)) != len(ids) or
                        type(plan.get('dueCount')) is not int or plan['dueCount'] < len(ids) or
                        (not ids and plan['dueCount'] != 0)):
                    raise DeployError('invalid_response')
                if not ids:
                    break
                counts['refreshRequests'] += 1
                result = self.api.request('POST', '/v1/metadata/refresh', {'workIds': ids})
                refresh = result.get('refresh', {})
                if (not isinstance(refresh, dict) or set(refresh) != {'ok', 'unavailable', 'apiError'} or
                        any(type(refresh[k]) is not int or refresh[k] < 0 for k in refresh) or sum(refresh.values()) != len(ids)):
                    raise DeployError('invalid_response')
                counts['batches'] += 1
                for key in refresh:
                    counts[key] += refresh[key]
                if refresh['apiError']:
                    error_code = 'api_error'
            else:
                # Check after the final allowed batch rather than failing a run
                # that processed exactly its capacity.
                if self.api.request('GET', '/v1/maintenance/plan').get('dueCount') != 0:
                    raise DeployError('batch_limit')
        except Exception as error:
            error_code = self.code(error)
        # Quota and upstream failures do not extend retention. Independently
        # attempt the existing atomic deletion policy even on a failed refresh.
        try:
            for attempt in range(3):
                state = self.api.request('GET', '/v1/state')
                if type(state.get('generation')) is not int or state['generation'] < 0:
                    raise DeployError('invalid_response')
                try:
                    removed = self.api.request('POST', '/v1/maintenance/delete-eligible', {'expectedGeneration': state['generation']})
                    if type(removed.get('removedCount')) is not int or removed['removedCount'] < 0:
                        raise DeployError('invalid_response')
                    counts['deleted'] += removed['removedCount']
                    break
                except DeployError as error:
                    if error.status != 409 or attempt == 2:
                        raise
        except Exception as error:
            error_code = self.code(error)
        # Write publication outputs even on partial maintenance, so deletions or
        # already-committed refreshes still reach the shared publication workflow.
        try:
            self.output_state()
        except Exception as error:
            error_code = self.code(error)
        outcome = 'success' if error_code is None else 'partial'
        payload = {'outcome': outcome, 'counts': counts}
        if error_code:
            payload['errorCode'] = error_code
        self.api.request('POST', '/v1/maintenance/runs/' + self.run_id + '/finish', payload)
        print('CCM maintenance: ' + outcome + (': ' + error_code if error_code else ''))
        return 0 if error_code is None else 1


def main():
    try:
        return MaintenanceRunner().run()
    except Exception:
        # No exception message: upstream errors can carry URLs or private data.
        print('CCM maintenance: result_record_or_connection_failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
