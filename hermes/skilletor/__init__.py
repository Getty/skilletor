"""skilletor for Hermes Agent: a thin adapter (spec §16.4, README "Hermes Agent").

Nothing is decided here. The skilletor CLI checks, syncs and reports; this
module runs the two hook commands the Claude Code and Codex hook files run and
hands their answer to Hermes:

  on_session_start  `skilletor hook session-start --harness hermes`. Hermes
                    ignores what this hook returns, so the answer is kept for
                    the session.
  pre_llm_call      the kept answer; in a session this process did not start
                    (a resumed one fires no on_session_start) session-start,
                    now; on every later turn `skilletor hook
                    user-prompt-submit --harness hermes`, which starts a
                    background sync when one is due and delivers the report
                    of an earlier one. The text goes to the model as
                    {"context": <text>} – Hermes appends it to the turn's user
                    message.

A delegated child (platform "subagent", or a parent_session_id) gets neither:
it is work of the session that spawned it, not a session of the user's.

Fail open, everywhere. No CLI, a non-zero exit, no JSON, an answer after the
limit: the turn runs without a message. The limits, SESSION_START_S and
PROMPT_S, are below Hermes' own for a hook callback
(plugins.hook_callback_timeout, 30 s), after which Hermes abandons the callback
and skips it for a minute; a child that runs into ours is killed.

The CLI is $SKILLETOR_BIN if set – then that or nothing; else bin/skilletor of
the checkout this directory is a symlink into; else `skilletor` on PATH. The
child runs with the session's Hermes home as HERMES_HOME, and skilletor takes
the project from the `cwd` it is sent.

Importing this module and register() start nothing and read nothing.
"""

import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
from collections import OrderedDict

logger = logging.getLogger(__name__)

HARNESS = "hermes"
SESSION_START_S = 20    # hooks/hooks.json gives the same command 30 s
PROMPT_S = 5            # … and this one 10 s
REAP_S = 0.2            # a killed child gets this long to go
MAX_SESSIONS = 256      # sessions remembered per registration (a gateway runs for days)
SUBAGENT = "subagent"   # tools/delegate_tool.py: the platform of a delegated child

# The project a hook takes from its environment (src/cli.ts). Hermes started from a
# Claude Code session inherits it; the session's own `cwd` is what counts here.
PROJECT_VARS = ("SKILLETOR_PROJECT_DIR", "CLAUDE_PROJECT_DIR")

FRESH, SEEN = "fresh", "seen"


def find_cli(environ, here):
    """The skilletor CLI this plugin adapts, or None."""
    named = environ.get("SKILLETOR_BIN")
    if named:
        return named if os.path.isfile(named) and os.access(named, os.X_OK) else None
    root = os.path.dirname(os.path.dirname(os.path.realpath(here)))
    shim = os.path.join(root, "bin", "skilletor")
    if os.access(shim, os.X_OK) and os.path.isfile(os.path.join(root, "dist", "skilletor.js")):
        return shim
    return shutil.which("skilletor", path=environ.get("PATH"))


def hermes_home(environ):
    """The Hermes home of the session being served: the active profile's, also
    where one process serves several (a context-local override)."""
    try:
        from hermes_constants import get_hermes_home
        return str(get_hermes_home())
    except Exception:  # noqa: BLE001 — not inside Hermes, or an older one
        return environ.get("HERMES_HOME") or None


def session_cwd():
    """Where the session works: Hermes' own answer (the resolver it finds
    project skills with), else the process directory."""
    try:
        from agent.runtime_cwd import resolve_agent_cwd
        return str(resolve_agent_cwd())
    except Exception:  # noqa: BLE001
        try:
            return os.getcwd()
        except OSError:
            return None


def message_of(answer):
    """The text for the model in a hook answer, or None: its additionalContext;
    without one its systemMessage – in Claude Code the line the user sees, and
    a Hermes plugin hook has no channel of that kind."""
    if not isinstance(answer, dict):
        return None
    specific = answer.get("hookSpecificOutput")
    context = specific.get("additionalContext") if isinstance(specific, dict) else None
    line = answer.get("systemMessage")
    if isinstance(line, str) and line:
        logger.info("%s", line)
    for text in (context, line):
        if isinstance(text, str) and text:
            return text
    return None


class Adapter:
    """One registration: where the plugin lives, and which sessions it has seen."""

    def __init__(self, here, environ=None, home=hermes_home, cwd=session_cwd,
                 session_start_s=SESSION_START_S, prompt_s=PROMPT_S):
        self.here = here
        self.environ = os.environ if environ is None else environ
        self.home = home
        self.cwd = cwd
        self.session_start_s = session_start_s
        self.prompt_s = prompt_s
        self._lock = threading.Lock()
        self._sessions = OrderedDict()   # session id -> FRESH | SEEN
        self._kept = {}                  # session id -> the session-start message

    # --- the CLI ------------------------------------------------------------

    def child_env(self, hook=False):
        env = dict(self.environ)
        home = self.home(self.environ)
        if home:
            env["HERMES_HOME"] = home
        if hook:
            for name in PROJECT_VARS:
                env.pop(name, None)
        return env

    def hook(self, event, payload, limit):
        """The answer of `skilletor hook <event>` to payload, or None: no CLI,
        silence (nothing to say), no answer within limit, a non-zero exit,
        anything that is not a JSON object."""
        cli = find_cli(self.environ, self.here)
        if cli is None:
            return None
        cwd = payload.get("cwd")
        proc = subprocess.Popen(
            [cli, "hook", event, "--harness", HARNESS],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=self.child_env(hook=True), cwd=cwd if cwd and os.path.isdir(cwd) else "/",
            start_new_session=True)
        try:
            out, _ = proc.communicate(json.dumps(payload).encode("utf-8"), timeout=limit)
        except subprocess.TimeoutExpired:
            # The shim and its node, not the detached background sync (a session of
            # its own). Not waited for beyond a moment: Hermes has a limit too.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()
            try:
                proc.wait(timeout=REAP_S)
            except subprocess.TimeoutExpired:
                pass
            return None
        finally:
            for pipe in (proc.stdin, proc.stdout):
                try:
                    pipe.close()
                except OSError:
                    pass
        if proc.returncode != 0 or not out.strip():
            return None
        try:
            answer = json.loads(out.decode("utf-8"))
        except ValueError:
            return None
        return answer if isinstance(answer, dict) else None

    def payload(self, event, session_id, **more):
        payload = {"hook_event_name": event, "session_id": session_id, "cwd": self.cwd()}
        payload.update(more)
        return payload

    # --- sessions -----------------------------------------------------------

    def start(self, session_id, source):
        """Run session-start for a session this registration has not seen and
        keep its message. False if the session is known already."""
        with self._lock:
            if session_id in self._sessions:
                return False
            self._sessions[session_id] = FRESH
            while len(self._sessions) > MAX_SESSIONS:
                gone, _ = self._sessions.popitem(last=False)
                self._kept.pop(gone, None)
        text = message_of(self.hook(
            "session-start", self.payload("SessionStart", session_id, source=source),
            self.session_start_s))
        if text:
            with self._lock:
                if session_id in self._sessions:
                    self._kept[session_id] = text
        return True

    # --- Hermes' hooks --------------------------------------------------------

    def on_session_start(self, session_id="", platform="", **kwargs):
        try:
            if platform != SUBAGENT:
                self.start(session_id, "startup")
        except Exception:  # noqa: BLE001 — a session always starts
            pass
        return None

    def pre_llm_call(self, session_id="", platform="", parent_session_id="", **kwargs):
        try:
            if platform == SUBAGENT or parent_session_id:
                return None
            self.start(session_id, "resume")
            with self._lock:
                fresh = self._sessions.get(session_id) == FRESH
                if fresh:
                    self._sessions[session_id] = SEEN
                text = self._kept.pop(session_id, None)
            if not fresh:
                # Session-start ran in an earlier turn: this is a prompt like any other.
                text = message_of(self.hook(
                    "user-prompt-submit", self.payload("UserPromptSubmit", session_id),
                    self.prompt_s))
            if text:
                return {"context": text}
        except Exception:  # noqa: BLE001 — a turn always runs
            pass
        return None

    # --- hermes skilletor … ---------------------------------------------------

    def command(self, args):
        """`hermes skilletor <arguments>`: the CLI, for this Hermes home."""
        cli = find_cli(self.environ, self.here)
        if cli is None:
            print("skilletor: CLI not found (set SKILLETOR_BIN, link this plugin to a "
                  "skilletor checkout, or put skilletor on PATH)", file=sys.stderr)
            raise SystemExit(1)
        raise SystemExit(subprocess.call([cli] + list(args.args), env=self.child_env()))


def setup_command(parser):
    import argparse
    parser.add_argument("args", nargs=argparse.REMAINDER,
                        help="command and options of the skilletor CLI (try: status)")


def register(ctx):
    adapter = Adapter(os.path.dirname(os.path.abspath(__file__)))
    ctx.register_hook("on_session_start", adapter.on_session_start)
    ctx.register_hook("pre_llm_call", adapter.pre_llm_call)
    # Absent on a Hermes without plugin CLI commands: the hooks still serve.
    register_cli = getattr(ctx, "register_cli_command", None)
    if register_cli is not None:
        register_cli(
            "skilletor", "Run the skilletor CLI for this Hermes home", setup_command,
            adapter.command,
            description="Passes its arguments to the skilletor CLI with this Hermes "
                        "home as HERMES_HOME, e.g. `hermes skilletor status`.")
