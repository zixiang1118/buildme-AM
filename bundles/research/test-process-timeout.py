#!/usr/bin/env python3
"""Isolated Windows venv-launcher regression check; never starts a real search."""
from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def alive(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return exit_code.value == 259
    finally:
        kernel.CloseHandle(handle)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, help="An installed Windows venv interpreter, used only for the owned stub")
    args = parser.parse_args()
    helper_path = Path(__file__).resolve().parents[2] / "scripts" / "research-chemistry.py"
    spec = importlib.util.spec_from_file_location("chemistry_bridge_timeout_test", helper_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    original_run = bridge.run_with_tree_timeout
    original_env = {key: os.environ.get(key) for key in ("BUILDME_RESEARCH_RUNTIME_CONFIG", "PYTHONPATH")}
    with tempfile.TemporaryDirectory(prefix="buildme-owned-timeout-test-") as temporary:
        root = Path(temporary)
        fixture = root / "stub-packages"
        package = fixture / "aizynthfinder" / "interfaces"
        package.mkdir(parents=True)
        (package.parent / "__init__.py").write_text("", encoding="utf-8")
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "aizynthcli.py").write_text(
            "import json,os,subprocess,sys,time\n"
            "from pathlib import Path\n"
            "def main():\n"
            "    child = subprocess.Popen([sys.executable, '-c', "
            "\"import json,os,time; from pathlib import Path; Path('child.json').write_text(json.dumps({'pid':os.getpid()})); time.sleep(120)\"], "
            "creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)\n"
            "    Path('worker.json').write_text(json.dumps({'pid':os.getpid(),'childLauncherPid':child.pid}))\n"
            "    time.sleep(120)\n", encoding="utf-8",
        )
        metadata = fixture / "aizynthfinder-4.4.1.dist-info"
        metadata.mkdir()
        (metadata / "METADATA").write_text("Metadata-Version: 2.1\nName: aizynthfinder\nVersion: 4.4.1\n", encoding="utf-8")
        # The fixture only reads the bridge's JSON-subset configuration.
        (fixture / "yaml.py").write_text("import json\ndef safe_load(value): return json.loads(value)\n", encoding="utf-8")
        files = {}
        for name in ("model", "template", "filter", "stock"):
            files[name] = root / (name + ".fixture")
            files[name].write_text("isolated test fixture, not a chemistry model", encoding="utf-8")
        policy = {
            "expansion": {"test": {"type": "template-based", "model": str(files["model"]), "template": str(files["template"])}},
            "filter": {"test": {"type": "quick-filter", "model": str(files["filter"])}},
            "stock": {"test": {"type": "inchiset", "path": str(files["stock"])}},
        }
        policy_path = root / "policies.json"
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        config_path = root / "config.json"
        config_path.write_text(json.dumps({"python": args.python, "retrosynthesisPython": args.python, "retrosynthesisConfig": str(policy_path)}), encoding="utf-8")
        os.environ["BUILDME_RESEARCH_RUNTIME_CONFIG"] = str(config_path)
        os.environ["PYTHONPATH"] = str(fixture)
        # Shorten only this owned stub's effective deadline, preserving production defaults.
        def short_stub(command, *, timeout, **kwargs):
            return original_run(command, timeout=5 if "--config" in command else timeout, **kwargs)
        bridge.run_with_tree_timeout = short_stub
        try:
            result = bridge.retrosynthesis({"smiles": "CCO", "timeLimitSeconds": 5, "maxTransforms": 1})
            assert result["code"] == "RETROSYNTHESIS_TIMEOUT", result
            run_dir = Path(result["logDirectory"])
            worker = json.loads((run_dir / "worker.json").read_text())
            child = json.loads((run_dir / "child.json").read_text())
            provenance = json.loads((run_dir / "provenance.json").read_text(encoding="utf-8"))
            cleanup = provenance["processTreeCleanup"]
            owned_pids = sorted({worker["pid"], worker["childLauncherPid"], child["pid"], cleanup["workerPid"]})
            time.sleep(0.2)
            living = [pid for pid in owned_pids if alive(pid)]
            assert not living, {"unexpectedLiveOwnedPids": living, "cleanup": cleanup}
            assert provenance["executionStatus"] == "timeout"
            assert result["routes"] == [] and result["runId"]
            print(json.dumps({"ok": True, "fixtureOnly": True, "code": result["code"], "trackedOwnedPids": owned_pids, "liveOwnedPids": living, "processTreeCleanup": cleanup, "temporaryLogsRemovedAfterTest": True}, ensure_ascii=False))
        finally:
            bridge.run_with_tree_timeout = original_run
            for key, value in original_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    main()
