"""Drives hermes/skilletor/__init__.py outside Hermes (test/hermes-plugin.test.ts).

stdin, one JSON object:
  plugin    the plugin directory
  mode      "register": call register() with a recording context
            "adapter":  build an Adapter and run `steps` on it
  environ   the Adapter's environment (adapter mode)
  home, cwd what the Adapter's home and cwd lookups answer (adapter mode)
  limits    {"session_start_s": …, "prompt_s": …} (adapter mode, optional)
  steps     [[method, kwargs], …] (adapter mode)
stdout: one JSON object with what happened.
"""

import importlib.util
import inspect
import json
import os
import sys
import time


def load(plugin_dir):
    """The module by path and under a name of no package, as Hermes loads it."""
    spec = importlib.util.spec_from_file_location(
        "skilletor_hermes_under_test", os.path.join(plugin_dir, "__init__.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Context:
    """What register() may call, recorded."""

    def __init__(self):
        self.hooks = {}
        self.cli = {}

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli[name] = {"help": help, "description": description,
                          "setup": callable(setup_fn), "handler": callable(handler_fn)}


def var_kwargs(callback):
    return any(p.kind is inspect.Parameter.VAR_KEYWORD
               for p in inspect.signature(callback).parameters.values())


def main():
    job = json.load(sys.stdin)
    plugin = load(job["plugin"])
    out = {}
    if job["mode"] == "register":
        ctx = Context()
        plugin.register(ctx)
        out["hooks"] = {name: [var_kwargs(cb) for cb in cbs] for name, cbs in ctx.hooks.items()}
        out["cli"] = ctx.cli
        old = type("Old", (), {"register_hook": Context.register_hook, "hooks": {}})()
        plugin.register(old)  # a Hermes without register_cli_command
        out["hooks_without_cli"] = sorted(old.hooks)
        out["limits"] = [plugin.SESSION_START_S, plugin.PROMPT_S]
    else:
        adapter = plugin.Adapter(
            job["plugin"], environ=job["environ"], home=lambda environ: job.get("home"),
            cwd=lambda: job.get("cwd"), **job.get("limits", {}))
        out["cli"] = plugin.find_cli(job["environ"], job["plugin"])
        out["results"] = []
        for method, kwargs in job["steps"]:
            started = time.monotonic()
            try:
                ret = getattr(adapter, method)(**kwargs)
                out["results"].append({"ret": ret, "took": time.monotonic() - started})
            except BaseException as exc:  # noqa: BLE001 — a hook that raises is the finding
                out["results"].append({"raised": repr(exc), "took": time.monotonic() - started})
        out["sessions"] = len(adapter._sessions)
        out["kept"] = len(adapter._kept)
    json.dump(out, sys.stdout)


main()
