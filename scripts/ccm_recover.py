#!/usr/bin/env python3
"""Recover an abandoned CCM publisher only from conclusive GitHub evidence.

Never use age, the current commit's Pages status, or a cancelled workflow alone
as proof that an older Pages deployment cannot finish. The official deploy-pages
step succeeds only after Pages reports success. A skipped step made no request.
Other cases remain locked and require investigation rather than unsafe retry.
"""

import os
import re
import sys

from ccm_deploy import ApiClient, DeployError


DEPLOY_STEP = 'Deploy to GitHub Pages'
PREPARE_STEP = 'Read and validate approved snapshot; record attempt in D1'
TERMINAL_CONCLUSIONS = {'success', 'failure', 'cancelled', 'timed_out', 'action_required',
                        'stale', 'startup_failure', 'neutral', 'skipped'}


def terminal_evidence(github, repository, attempt):
    match = re.fullmatch(r'([0-9]{1,24})-([0-9]{1,8})', attempt.get('attemptId', ''))
    if not match or type(attempt.get('authorized')) is not bool:
        raise DeployError('invalid_active_attempt')
    run_id, run_attempt = match.groups()
    prefix = '/repos/' + repository + '/actions/runs/' + run_id + '/attempts/' + run_attempt
    run = github.request('GET', prefix)
    run_repository = run.get('repository')
    run_sha = run.get('head_sha')
    if (str(run.get('id')) != run_id or run.get('run_attempt') != int(run_attempt)
            or not isinstance(run_repository, dict)
            or str(run_repository.get('full_name', '')).lower() != repository.lower()
            or not isinstance(run_sha, str) or not re.fullmatch(r'[0-9a-f]{40}', run_sha)
            or run.get('path') not in ('.github/workflows/deploy.yml', '.github/workflows/maintenance.yml')
            or run.get('head_branch') != 'main'
            or run.get('event') not in ('workflow_dispatch', 'schedule')
            or run.get('status') != 'completed'
            or run.get('conclusion') not in TERMINAL_CONCLUSIONS):
        raise DeployError('prior_run_not_terminal')
    result = github.request('GET', prefix + '/jobs?per_page=100')
    jobs = result.get('jobs')
    # Fail closed if paginated/truncated; CCM normally has at most three jobs.
    if (not isinstance(jobs, list) or not jobs or result.get('total_count') != len(jobs)
            or len(jobs) > 100):
        raise DeployError('incomplete_prior_jobs')
    matching = []
    for job in jobs:
        if not isinstance(job, dict) or not isinstance(job.get('steps'), list):
            raise DeployError('invalid_prior_jobs')
        steps = job['steps']
        if any(step.get('name') == PREPARE_STEP for step in steps if isinstance(step, dict)):
            matching.append(job)
    if len(matching) != 1:
        raise DeployError('ambiguous_prior_publisher')
    job = matching[0]
    if (str(job.get('run_id')) != run_id or job.get('status') != 'completed'
            or job.get('head_sha') != run_sha or job.get('head_branch') != 'main'
            or ('run_attempt' in job and job['run_attempt'] != int(run_attempt))):
        raise DeployError('prior_publisher_not_terminal')
    pages_steps = [step for step in job['steps'] if isinstance(step, dict) and step.get('name') == DEPLOY_STEP]
    if len(pages_steps) != 1 or pages_steps[0].get('status') != 'completed':
        raise DeployError('pages_termination_unknown')
    conclusion = pages_steps[0].get('conclusion')
    if conclusion == 'success' and attempt['authorized']:
        pages_conclusion = 'success'
    elif conclusion == 'skipped':
        pages_conclusion = 'not_started'
    else:
        raise DeployError('pages_termination_unknown')
    return {'runId': run_id, 'runAttempt': int(run_attempt), 'runConclusion': run['conclusion'],
            'pagesConclusion': pages_conclusion}


def recover(env=None, api=None, github=None):
    env = dict(os.environ if env is None else env)
    api = api or ApiClient(env.get('CCM_API_BASE_URL', ''), env.get('CCM_DEPLOY_TOKEN', ''))
    active = api.request('GET', '/v1/deployments/active')
    if 'attempt' not in active:
        raise DeployError('invalid_active_attempt')
    attempt = active['attempt']
    if attempt is None:
        print('no_abandoned_deployment')
        return
    if not isinstance(attempt, dict):
        raise DeployError('invalid_active_attempt')
    repository = env.get('GITHUB_REPOSITORY', '')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise DeployError('invalid_github_repository')
    current_attempt = env.get('GITHUB_RUN_ID', '') + '-' + env.get('GITHUB_RUN_ATTEMPT', '')
    if attempt.get('attemptId') == current_attempt:
        raise DeployError('cannot_recover_current_attempt')
    github = github or ApiClient('https://api.github.com', env.get('GITHUB_TOKEN', ''))
    evidence = terminal_evidence(github, repository, attempt)
    result = api.request('POST', '/v1/deployments/' + attempt['attemptId'] + '/recover', evidence)
    if (result.get('recovered') is not True or result.get('attemptId') != attempt['attemptId']
            or result.get('revision') != attempt.get('revision')):
        raise DeployError('invalid_recovery_response')
    print('abandoned_deployment_recovered attempt=' + attempt['attemptId'])


def main():
    try:
        recover()
        return 0
    except DeployError as error:
        print('CCM recovery error: ' + error.code, file=sys.stderr)
        return 1
    except Exception:
        print('CCM recovery error: local_operation_failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
