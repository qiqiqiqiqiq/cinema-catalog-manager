#!/usr/bin/env python3
"""Authenticated CCM publication lifecycle. Never print API bodies or secrets."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


MAX_RESPONSE_BYTES = 16 * 1024 * 1024
CONTEXT_VERSION = 1


class DeployError(Exception):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code = code
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # In particular, never forward the Worker bearer token to another host.
        return None


def read_bounded(response):
    data = response.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise DeployError("response_too_large")
    return data


def safe_url(value):
    if not isinstance(value, str):
        raise DeployError("invalid_url_configuration")
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise DeployError("invalid_url_configuration")
    return value.rstrip("/")


class ApiClient:
    def __init__(self, base_url, token, opener=None):
        self.base_url = safe_url(base_url)
        if not isinstance(token, str) or not token or "\r" in token or "\n" in token:
            raise DeployError("missing_api_configuration")
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=True).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path, data=data, method=method,
            headers={"Authorization": "Bearer " + self.token,
                     "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = read_bounded(response)
            result = json.loads(raw)
        except urllib.error.HTTPError as exc:
            # Do not read or log server error bodies, SQL, URLs, or exception strings.
            raise DeployError("api_http_" + str(exc.code), exc.code) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise DeployError("api_unreachable") from None
        except (ValueError, UnicodeError):
            raise DeployError("invalid_api_response") from None
        if not isinstance(result, dict):
            raise DeployError("invalid_api_response")
        return result


def fetch_public(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            return read_bounded(response)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise DeployError("public_fetch_failed") from None


def positive_int(value):
    return type(value) is int and 0 < value <= 9007199254740991


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DeployError("invalid_public_json")
        result[key] = value
    return result


def reject_non_json_number(value):
    raise DeployError("invalid_public_json")


def require_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise DeployError("invalid_public_json")


def validate_publication(publication):
    """Validate both allowlists and references; preserve the exact original bytes."""
    if not isinstance(publication, dict) or not positive_int(publication.get("revision")):
        raise DeployError("invalid_publication_revision")
    texts = [publication.get("libraryJson"), publication.get("queueJson")]
    if not all(isinstance(value, str) for value in texts):
        raise DeployError("invalid_public_json")
    try:
        library, queue = [json.loads(value, object_pairs_hook=strict_object,
                                    parse_constant=reject_non_json_number) for value in texts]
        encoded = [value.encode("utf-8") for value in texts]
    except (ValueError, UnicodeError):
        raise DeployError("invalid_public_json") from None
    require_keys(library, ("version", "movies"))
    require_keys(queue, ("version", "queue"))
    if (type(library["version"]) is not int or library["version"] != 1
            or type(queue["version"]) is not int or queue["version"] != 1
            or not isinstance(library["movies"], list) or not isinstance(queue["queue"], list)):
        raise DeployError("invalid_public_json")
    movie_ids = set()
    for movie in library["movies"]:
        require_keys(movie, ("id", "title", "genre", "url"))
        if not all(isinstance(movie[field], str) for field in movie):
            raise DeployError("invalid_public_json")
        if not movie["id"] or movie["id"] in movie_ids:
            raise DeployError("invalid_movie_id")
        parsed = urllib.parse.urlsplit(movie["url"])
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if (parsed.scheme != "https" or parsed.netloc != "www.youtube.com"
                or parsed.path != "/watch" or parsed.fragment
                or set(query) != {"v"} or len(query["v"]) != 1 or not query["v"][0]):
            raise DeployError("invalid_video_url")
        movie_ids.add(movie["id"])
    queue_ids = set()
    for item in queue["queue"]:
        require_keys(item, ("id", "movieId"))
        if not isinstance(item["id"], str) or not item["id"] or item["id"] in queue_ids:
            raise DeployError("invalid_queue_id")
        if not isinstance(item["movieId"], str) or item["movieId"] not in movie_ids:
            raise DeployError("unknown_movie_reference")
        queue_ids.add(item["id"])
    return tuple(encoded)


class DeploymentRunner:
    def __init__(self, env=None, cwd=None, api=None, public_fetch=None, sleep=None):
        self.env = dict(os.environ if env is None else env)
        self.cwd = Path.cwd().resolve() if cwd is None else Path(cwd).resolve()
        run_id = self.env.get("GITHUB_RUN_ID", "")
        run_attempt = self.env.get("GITHUB_RUN_ATTEMPT", "")
        if not re.fullmatch(r"[0-9]{1,24}", run_id) or not re.fullmatch(r"[0-9]{1,12}", run_attempt):
            raise DeployError("invalid_run_identity")
        self.attempt_id = run_id + "-" + run_attempt
        runner_temp = self.env.get("RUNNER_TEMP", "")
        if not runner_temp or not Path(runner_temp).is_absolute():
            raise DeployError("missing_runner_temp")
        temp_dir = Path(runner_temp).resolve()
        if temp_dir == self.cwd or self.cwd in temp_dir.parents:
            raise DeployError("context_inside_artifact")
        temp_dir.mkdir(parents=True, exist_ok=True)
        self.context_path = temp_dir / ("ccm-deploy-" + self.attempt_id + ".json")
        self._api = api
        self.public_fetch = public_fetch or fetch_public
        self.sleep = sleep or time.sleep

    @property
    def api(self):
        if self._api is None:
            self._api = ApiClient(self.env.get("CCM_API_BASE_URL", ""), self.env.get("CCM_DEPLOY_TOKEN", ""))
        return self._api

    def save(self, context):
        temporary = self.context_path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(context, stream, ensure_ascii=True, separators=(",", ":"))
        temporary.replace(self.context_path)

    def load(self, required=True):
        if not self.context_path.exists():
            if required:
                raise DeployError("missing_attempt_context")
            return None
        try:
            context = json.loads(self.context_path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError, OSError):
            raise DeployError("invalid_attempt_context") from None
        if (not isinstance(context, dict) or context.get("contextVersion") != CONTEXT_VERSION
                or context.get("attemptId") != self.attempt_id
                or not positive_int(context.get("revision"))):
            raise DeployError("invalid_attempt_context")
        return context

    def call(self, context, method, path, body=None):
        try:
            return self.api.request(method, path, body)
        except DeployError as exc:
            context["errorCode"] = exc.code
            if context.get("phase") == "authorize" and exc.status == 409:
                context["superseded"] = True
            self.save(context)
            raise

    def prepare(self):
        if self.context_path.exists():
            raise DeployError("attempt_context_exists")
        requested = self.env.get("REQUESTED_REVISION", "").strip()
        if requested and not re.fullmatch(r"[1-9][0-9]{0,15}", requested):
            raise DeployError("invalid_requested_revision")
        publication = self.api.request("GET", "/v1/publication")
        library_bytes, queue_bytes = validate_publication(publication)
        revision = publication["revision"]
        if requested and int(requested) != revision:
            # No begin call, hence no publication lock is acquired for an obsolete request.
            raise DeployError("requested_revision_superseded")
        context = {"contextVersion": CONTEXT_VERSION, "attemptId": self.attempt_id,
                   "revision": revision, "phase": "prepare", "beginRequested": True,
                   "began": False, "authorized": False, "libraryMatches": False,
                   "queueMatches": False, "retryCount": 0}
        self.save(context)  # Covers a lost response after begin commits at the server.
        result = self.call(context, "POST", "/v1/deployments/begin",
                           {"attemptId": self.attempt_id, "expectedRevision": revision})
        if result.get("attemptId") != self.attempt_id or result.get("revision") != revision:
            raise DeployError("invalid_begin_response")
        context["began"] = True
        self.save(context)
        (self.cwd / "library.json").write_bytes(library_bytes)
        (self.cwd / "queue.json").write_bytes(queue_bytes)
        context["phase"] = "prepared"
        self.save(context)
        output = self.env.get("GITHUB_OUTPUT")
        if output:
            with open(output, "a", encoding="utf-8") as stream:
                stream.write("revision=" + str(revision) + "\n")
        print("publication_prepared revision=" + str(revision))

    def authorize(self):
        context = self.load()
        if not context.get("began") or context.get("finishPayload"):
            raise DeployError("attempt_not_active")
        context["phase"] = "authorize"
        self.save(context)
        result = self.call(context, "POST", "/v1/deployments/" + self.attempt_id + "/authorize", {})
        if result.get("authorized") is not True or result.get("revision") != context["revision"]:
            raise DeployError("invalid_authorization_response")
        context["authorized"] = True
        context["phase"] = "authorized"
        context.pop("errorCode", None)
        self.save(context)
        print("publication_authorized revision=" + str(context["revision"]))

    def verify(self, delays=(120, 480, 1200)):
        context = self.load()
        if not context.get("authorized") or context.get("finishPayload"):
            raise DeployError("attempt_not_authorized")
        base_url = safe_url(self.env.get("PAGE_URL", ""))
        expected = ((self.cwd / "library.json").read_bytes(), (self.cwd / "queue.json").read_bytes())
        for index, delay in enumerate(delays):
            self.sleep(delay)
            context.update(phase="verify", retryCount=index, libraryMatches=False, queueMatches=False)
            fetch_failed = False
            for name, field, expected_bytes in zip(("library.json", "queue.json"),
                                                   ("libraryMatches", "queueMatches"), expected):
                try:
                    context[field] = self.public_fetch(base_url + "/" + name) == expected_bytes
                except DeployError:
                    fetch_failed = True
            if context["libraryMatches"] and context["queueMatches"]:
                context["phase"] = "verified"
                context.pop("errorCode", None)
                self.save(context)
                print("publication_verified revision=" + str(context["revision"]))
                return
            context["errorCode"] = "public_fetch_failed" if fetch_failed else "public_content_mismatch"
            self.save(context)
            print("publication_not_yet_verified attempt=" + str(index + 1))
        raise DeployError(context["errorCode"])

    def finish(self):
        context = self.load(required=False)
        if context is None:
            print("no_deployment_attempt_started")
            return
        payload = context.get("finishPayload")
        if payload is None:
            deploy_outcome = self.env.get("DEPLOY_OUTCOME", "")
            verify_outcome = self.env.get("VERIFY_OUTCOME", "")
            deployed = deploy_outcome == "success"
            library_matches = bool(context.get("libraryMatches"))
            queue_matches = bool(context.get("queueMatches"))
            verified = (deployed and verify_outcome == "success" and context.get("authorized")
                        and context.get("phase") == "verified" and library_matches and queue_matches)
            phase = context.get("phase", "prepare")
            phase = {"prepared": "prepare", "authorized": "authorize", "verified": "verify"}.get(phase, phase)
            # Only fixed internal reason codes enter durable D1 records.
            error_code = "prepare_failed"
            if verified:
                outcome, phase, error_code = "verified", "verify", None
            elif deployed:
                outcome, phase = "failed", "verify"
                error_code = ("public_fetch_failed" if context.get("errorCode") == "public_fetch_failed"
                              else "verification_failed")
            elif context.get("authorized") and deploy_outcome != "skipped":
                # Action timeout/cancellation/failure can leave a remote deploy in flight.
                # Record uncertainty, retaining the server lock for explicit recovery.
                outcome, phase, error_code = "uncertain", "deploy", "deployment_unknown"
            elif context.get("superseded"):
                outcome, phase, error_code = "superseded", "authorize", "revision_changed"
            else:
                outcome = "failed"
                if context.get("authorized"):
                    phase, error_code = "deploy", "cancelled"
                elif phase == "authorize":
                    error_code = "revision_check_failed"
                elif self.env.get("ARTIFACT_OUTCOME") == "failure":
                    error_code = "artifact_failed"
            payload = {"outcome": outcome, "deployed": deployed,
                       "libraryMatches": library_matches, "queueMatches": queue_matches,
                       "phase": phase, "retryCount": context.get("retryCount", 0)}
            if error_code is not None:
                payload["errorCode"] = error_code
            context["finishPayload"] = payload
            self.save(context)  # Exact replay after an unknown callback result.
        result = self.api.request("POST", "/v1/deployments/" + self.attempt_id + "/finish", payload)
        recorded_outcome = result.get("outcome")
        outcome_matches = (recorded_outcome == payload["outcome"]
                           or (payload["outcome"] == "verified" and recorded_outcome == "superseded"))
        if result.get("revision") != context["revision"] or not outcome_matches:
            raise DeployError("invalid_finish_response")
        context["finishRecorded"] = True
        context["recordedOutcome"] = recorded_outcome
        self.save(context)
        print("deployment_result_recorded outcome=" + recorded_outcome)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "authorize", "verify", "finish"))
    args = parser.parse_args(argv)
    try:
        runner = DeploymentRunner()
        getattr(runner, args.command)()
        return 0
    except DeployError as exc:
        print("CCM deployment error: " + exc.code, file=sys.stderr)
        return 1
    except Exception:
        # A traceback can include request URLs, secrets, or API-derived text.
        print("CCM deployment error: local_operation_failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
