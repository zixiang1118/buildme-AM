#!/usr/bin/env python3
"""Bounded JSON bridge for local BuildMe chemistry tools. No installer or shell."""
from __future__ import annotations

import contextlib
import gzip
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

MAX_INPUT_BYTES = 64 * 1024
MAX_ROUTE_BYTES = 8 * 1024 * 1024


def terminate_process_tree(worker: subprocess.Popen) -> dict:
    """Terminate only this bridge's worker and its children before reaping it.

    A Windows venv python.exe can launch another Python process. Killing just
    that launcher first loses the descendant relationship needed by taskkill.
    """
    cleanup = {"method": "taskkill-tree" if os.name == "nt" else "process-group", "workerPid": worker.pid}
    if os.name == "nt":
        taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
        try:
            result = subprocess.run(
                [str(taskkill), "/PID", str(worker.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                timeout=10, shell=False, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            cleanup["returnCode"] = result.returncode
            if result.returncode != 0:
                cleanup["diagnostic"] = result.stderr[-1000:]
        except (OSError, subprocess.TimeoutExpired) as error:
            cleanup["diagnostic"] = str(error)
    else:
        try:
            os.killpg(worker.pid, signal.SIGKILL)
            cleanup["returnCode"] = 0
        except ProcessLookupError:
            cleanup["returnCode"] = 0
        except OSError as error:
            cleanup["diagnostic"] = str(error)
    try:
        worker.wait(timeout=5)
    except subprocess.TimeoutExpired:
        worker.kill()
        worker.wait(timeout=5)
        cleanup["fallbackParentKill"] = True
    return cleanup


def run_with_tree_timeout(command: list[str], *, timeout: float, **kwargs) -> subprocess.CompletedProcess:
    """Like subprocess.run, but kill the complete owned process tree on timeout."""
    with subprocess.Popen(
        command, shell=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        start_new_session=os.name != "nt", **kwargs,
    ) as worker:
        try:
            output, errors = worker.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            cleanup = terminate_process_tree(worker)
            output, errors = worker.communicate(timeout=5)
            error.output, error.stderr = output, errors
            error.process_tree_cleanup = cleanup
            raise
        return subprocess.CompletedProcess(command, worker.returncode, output, errors)


def runtime_root() -> Path:
    override = os.environ.get("BUILDME_RESEARCH_RUNTIME_CONFIG")
    if override:
        return Path(override).expanduser().resolve().parent
    base = os.environ.get("LOCALAPPDATA")
    return (Path(base) if base else Path.home() / ".local" / "share") / "BuildMe" / "research-runtime"


def read_config() -> dict:
    path = Path(os.environ["BUILDME_RESEARCH_RUNTIME_CONFIG"]).expanduser().resolve() if os.environ.get("BUILDME_RESEARCH_RUNTIME_CONFIG") else runtime_root() / "config.json"
    if not path.is_file():
        return {}
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Runtime configuration is too large")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("Runtime configuration must be an object")
    return value


def version(package: str) -> str | None:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


# Executed only in the configured, isolated AiZynthFinder Python interpreter.
# Config files can select local supported policies, never arbitrary plugin classes.
RETRO_PROBE = r'''
import importlib.metadata, importlib.util, json, pathlib, sys
answer = {"ready": False, "missing": []}
try:
    answer["version"] = importlib.metadata.version("aizynthfinder")
    import yaml
    path = pathlib.Path(sys.argv[1]).resolve()
    if path.stat().st_size > 65536:
        raise ValueError("Configuration is too large")
    config = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    if not isinstance(config, dict):
        raise ValueError("Configuration must be an object")
    supported = {"expansion": {"template-based"}, "filter": {"quick-filter"}, "stock": {"inchiset"}}
    files = []
    for section, allowed in supported.items():
        policies = config.get(section)
        if not isinstance(policies, dict) or not policies:
            raise ValueError("Missing local " + section + " policy")
        for name, policy in policies.items():
            if not isinstance(policy, dict) or policy.get("type") not in allowed:
                raise ValueError("Unsupported " + section + " policy type")
            fields = ["model", "template"] if section == "expansion" else ["model"] if section == "filter" else ["path"]
            for field in fields:
                raw = policy.get(field)
                if not isinstance(raw, str) or "://" in raw:
                    raise ValueError("A local policy file is required")
                file_path = pathlib.Path(raw)
                if not file_path.is_absolute():
                    file_path = path.parent / file_path
                file_path = file_path.resolve()
                if not file_path.is_file():
                    answer["missing"].append(str(file_path))
                policy[field] = str(file_path)
                files.append({"kind": section + "." + field, "path": str(file_path)})
    answer["ready"] = not answer["missing"]
    answer["config"] = config
    answer["files"] = files
except Exception as error:
    answer["reason"] = str(error)
print(json.dumps(answer, ensure_ascii=False))
'''


def retro_probe(config: dict) -> dict:
    python_value = config.get("retrosynthesisPython")
    config_value = config.get("retrosynthesisConfig")
    if not isinstance(python_value, str) or not python_value or not Path(python_value).is_file():
        return {"ready": False, "reason": "逆合成运行环境尚未配置"}
    if not isinstance(config_value, str) or not config_value or not Path(config_value).is_file():
        return {"ready": False, "reason": "未配置本地策略模型和库存文件；不会生成替代路线"}
    try:
        run = run_with_tree_timeout(
            [python_value, "-c", RETRO_PROBE, config_value],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", timeout=20,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if run.returncode != 0:
            return {"ready": False, "reason": "无法检查逆合成环境", "diagnostic": run.stderr[-2000:]}
        if len(run.stdout.encode("utf-8")) > MAX_INPUT_BYTES:
            return {"ready": False, "reason": "逆合成配置检查输出超过限制"}
        return json.loads(run.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {"ready": False, "reason": str(error)}


def status() -> dict:
    config = read_config()
    retro = retro_probe(config)
    retro.pop("config", None)
    return {
        "ok": True, "action": "status", "python": sys.executable,
        "ready": bool(config.get("python")) and importlib.util.find_spec("rdkit") is not None,
        "configured": bool(config.get("python")),
        "code": None if config.get("python") else "RUNTIME_NOT_CONFIGURED",
        "message": None if config.get("python") else "本地科研运行环境尚未配置",
        "pythonVersion": sys.version.split()[0],
        "rdkit": {"ready": importlib.util.find_spec("rdkit") is not None, "version": version("rdkit")},
        "medchem": {"ready": importlib.util.find_spec("medchem") is not None, "version": version("medchem")},
        "retrosynthesis": retro, "configPath": str(Path(os.environ["BUILDME_RESEARCH_RUNTIME_CONFIG"]).expanduser().resolve() if os.environ.get("BUILDME_RESEARCH_RUNTIME_CONFIG") else runtime_root() / "config.json"),
    }


def parse_molecule(request: dict):
    smiles = request.get("smiles")
    if not isinstance(smiles, str) or not smiles.strip() or len(smiles.encode("utf-8")) > 4096:
        raise ValueError("请输入长度不超过 4096 字节的 SMILES")
    smiles = smiles.strip()
    if any(character in smiles for character in "\r\n\t"):
        raise ValueError("只接受一个分子结构；请删除换行或名称")
    try:
        from rdkit import Chem
    except ImportError as error:
        raise RuntimeError("RDKIT_NOT_READY") from error
    params = Chem.SmilesParserParams()
    params.parseName = False
    molecule = Chem.MolFromSmiles(smiles, params)
    if molecule is None or molecule.GetNumAtoms() == 0:
        raise ValueError("SMILES 无法解析，请检查价态、括号和立体化学")
    if molecule.GetNumAtoms() > 1000:
        raise ValueError("当前工具仅支持不超过 1000 个原子的结构")
    return smiles, molecule


def properties(request: dict) -> dict:
    original, molecule = parse_molecule(request)
    from rdkit import Chem, rdBase
    from rdkit.Chem import Crippen, Descriptors, Lipinski, rdMolDescriptors
    from rdkit.Chem.Draw import rdMolDraw2D
    canonical = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    centers = Chem.FindMolChiralCenters(molecule, includeUnassigned=True, useLegacyImplementation=False)
    descriptors = {
        "molecularWeight": round(Descriptors.MolWt(molecule), 4),
        "exactMass": round(rdMolDescriptors.CalcExactMolWt(molecule), 6),
        "logP": round(Crippen.MolLogP(molecule), 4),
        "tpsa": round(rdMolDescriptors.CalcTPSA(molecule), 4),
        "hBondDonors": Lipinski.NumHDonors(molecule),
        "hBondAcceptors": Lipinski.NumHAcceptors(molecule),
        "rotatableBonds": Lipinski.NumRotatableBonds(molecule),
        "ringCount": rdMolDescriptors.CalcNumRings(molecule),
        "aromaticRingCount": rdMolDescriptors.CalcNumAromaticRings(molecule),
        "formalCharge": Chem.GetFormalCharge(molecule),
        "atomCount": molecule.GetNumAtoms(),
        "molecularFormula": rdMolDescriptors.CalcMolFormula(molecule),
    }
    drawer = rdMolDraw2D.MolDraw2DSVG(480, 320)
    rdMolDraw2D.PrepareAndDrawMolecule(drawer, Chem.Mol(molecule))
    drawer.FinishDrawing()
    warnings = []
    if len(Chem.GetMolFrags(molecule)) > 1:
        warnings.append("输入包含多个片段（例如盐或混合物）；当前计算保留全部片段")
    if any(label == "?" for _, label in centers):
        warnings.append("存在未指定的手性中心；结果保留未指定状态")
    return {
        "ok": True, "action": "properties", "originalSmiles": original,
        "canonicalSmiles": canonical, "descriptors": descriptors,
        "svg": drawer.GetDrawingText(),
        "stereochemistry": {"chiralCenters": [{"atomIndex": index, "label": label} for index, label in centers]},
        "warnings": warnings, "provenance": "computed",
        "software": {"rdkit": rdBase.rdkitVersion},
        "normalization": {"desalted": False, "neutralized": False, "tautomerChanged": False},
        "interpretation": "结构计算不代表实测药效、入脑能力或安全性",
    }


def bounded_integer(value, default: int, minimum: int, maximum: int, field: str) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value:
        raise ValueError(field + " 必须是整数")
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError(f"{field} 必须在 {minimum}–{maximum} 范围内")
    return number


def extract_route_records(payload) -> tuple[list[dict], list[dict]]:
    """Handle pandas table/column JSON and older direct target records."""
    records = []
    if isinstance(payload, list):
        records = [row for row in payload if isinstance(row, dict)]
    elif isinstance(payload, dict):
        data = payload.get("data", payload)
        if isinstance(data, list):
            records = [row for row in data if isinstance(row, dict)]
        elif isinstance(data, dict):
            if isinstance(data.get("target"), str) or isinstance(data.get("trees"), list):
                records = [data]
            elif data and all(isinstance(column, dict) for column in data.values()):
                indices = {index for column in data.values() for index in column}
                records = [{key: column.get(index) for key, column in data.items()} for index in sorted(indices)]
            elif isinstance(data.get("target"), list):
                records = [{key: column[index] if isinstance(column, list) and index < len(column) else column for key, column in data.items()} for index in range(len(data["target"]))]
    routes = []
    for record in records:
        trees = record.get("trees") or record.get("top_score_routes") or []
        if isinstance(trees, list):
            routes.extend(tree for tree in trees if isinstance(tree, dict))
    return records, routes


def retrosynthesis(request: dict) -> dict:
    config = read_config()
    probe = retro_probe(config)
    if not probe.get("ready"):
        return {"ok": False, "action": "retrosynthesis", "code": "RETROSYNTHESIS_NOT_READY", "message": probe.get("reason", "策略模型或库存文件缺失"), "missing": probe.get("missing", []), "provenance": "unavailable", "routes": [], "runId": None, "logDirectory": None}
    original, molecule = parse_molecule(request)
    from rdkit import Chem
    canonical = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    if len(Chem.GetMolFrags(molecule)) != 1:
        raise ValueError("逆合成需要一个明确结构；请先确认盐／多片段的研究对象")
    seconds = bounded_integer(request.get("timeLimitSeconds"), 60, 5, 300, "timeLimitSeconds")
    depth = bounded_integer(request.get("maxTransforms"), 6, 1, 12, "maxTransforms")
    seed = bounded_integer(request.get("randomSeed"), 42, 0, 2**32 - 1, "randomSeed")
    run_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
    run_dir = runtime_root() / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    smiles_file = run_dir / "targets.smi"
    smiles_file.write_text(canonical + "\n", encoding="utf-8")
    effective = {section: probe["config"][section] for section in ("expansion", "filter", "stock")}
    effective["search"] = {"algorithm": "mcts", "time_limit": seconds, "iteration_limit": 100, "max_transforms": depth, "return_first": False, "exclude_target_from_stock": True}
    effective["post_processing"] = {"all_routes": True}
    # JSON is a YAML subset and preserves the reviewed local policy types and paths.
    config_file = run_dir / "config.yml"
    config_file.write_text(json.dumps(effective, ensure_ascii=False), encoding="utf-8")
    output_file = run_dir / "routes.json.gz"
    python = Path(config["retrosynthesisPython"])
    budget = {"targets": 1, "timeLimitSeconds": seconds, "maxTransforms": depth, "startupAllowanceSeconds": 90, "timeoutSeconds": seconds + 90, "randomSeed": seed}
    start = time.monotonic()
    # The configured venv interpreter may itself launch a base Python worker;
    # the timeout wrapper terminates that complete tree while its parent exists.
    command = [str(python), "-c", "import random,sys,numpy as np; seed=int(sys.argv.pop(1)); random.seed(seed); np.random.seed(seed); from aizynthfinder.interfaces.aizynthcli import main; main()", str(seed), "--config", str(config_file), "--smiles", str(smiles_file), "--output", str(output_file)]
    evidence = {"provenance": "predicted", "executionStatus": "running", "engine": "AiZynthFinder", "version": probe.get("version"), "bridgeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "originalSmiles": original, "canonicalSmiles": canonical, "configurationSha256": hashlib.sha256(config_file.read_bytes()).hexdigest(), "stockNames": list(effective["stock"]), "runBudget": budget, "runId": run_id}
    evidence_file = run_dir / "provenance.json"
    try:
        evidence["policyFiles"] = []
        for item in probe.get("files", []):
            policy_path = Path(item["path"])
            with policy_path.open("rb") as handle:
                sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
            evidence["policyFiles"].append({**item, "bytes": policy_path.stat().st_size, "sha256": sha256})
        source_manifest = config.get("sourceManifest")
        if isinstance(source_manifest, str) and Path(source_manifest).is_file() and Path(source_manifest).stat().st_size <= MAX_INPUT_BYTES:
            sources = json.loads(Path(source_manifest).read_text(encoding="utf-8-sig"))
            if isinstance(sources, dict) and isinstance(sources.get("files"), list):
                evidence["dataSources"] = [{key: item[key] for key in ("filename", "source", "url", "size", "md5", "sha256", "stockName", "license") if key in item} for item in sources["files"] if isinstance(item, dict)]
        evidence_file.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        with (run_dir / "stdout.log").open("w", encoding="utf-8") as stdout, (run_dir / "stderr.log").open("w", encoding="utf-8") as stderr:
            run = run_with_tree_timeout(command, cwd=str(run_dir), stdout=stdout, stderr=stderr, timeout=budget["timeoutSeconds"], env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        budget["elapsedSeconds"] = round(time.monotonic() - start, 3)
        if run.returncode != 0 or not output_file.is_file():
            evidence["executionStatus"] = "failed"
            evidence["exitCode"] = run.returncode
            evidence_file.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            return {"ok": False, "action": "retrosynthesis", "code": "RETROSYNTHESIS_FAILED", "message": "路线搜索失败；本地日志已保留", "runId": run_id, "runBudget": budget, "logDirectory": str(run_dir), "routes": []}
        with gzip.open(output_file, "rb") as handle:
            raw = handle.read(MAX_ROUTE_BYTES + 1)
        if len(raw) > MAX_ROUTE_BYTES:
            raise ValueError("路线结果超过 8 MiB；请缩小搜索深度")
        payload = json.loads(raw.decode("utf-8"))
        evidence["executionStatus"] = "success"
        evidence_file.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        records, trees = extract_route_records(payload)
        summary = [{key: record[key] for key in ("target", "is_solved", "number_of_routes", "number_of_solved_routes", "number_of_steps", "number_of_precursors_in_stock", "search_time", "first_solution_time") if key in record} for record in records]
        return {"ok": True, "action": "retrosynthesis", "provenance": "predicted", "runId": run_id, "runBudget": budget, "logDirectory": str(run_dir), "routes": trees, "routeSummary": summary, "routeData": payload, "evidence": evidence, "outputFile": str(output_file), "interpretation": "路线来自模型与指定库存，需文献和实验核验；未找到路线不表示无法合成"}
    except subprocess.TimeoutExpired as error:
        budget["elapsedSeconds"] = round(time.monotonic() - start, 3)
        evidence["executionStatus"] = "timeout"
        evidence["processTreeCleanup"] = getattr(error, "process_tree_cleanup", {})
        evidence_file.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": False, "action": "retrosynthesis", "code": "RETROSYNTHESIS_TIMEOUT", "message": "搜索已达到本次运行预算", "runId": run_id, "runBudget": budget, "logDirectory": str(run_dir), "routes": []}
    except Exception as error:
        budget["elapsedSeconds"] = round(time.monotonic() - start, 3)
        evidence["executionStatus"] = "failed"
        evidence["error"] = str(error)
        evidence_file.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": False, "action": "retrosynthesis", "code": "RETROSYNTHESIS_FAILED", "message": str(error), "runId": run_id, "runBudget": budget, "logDirectory": str(run_dir), "routes": []}


def main() -> None:
    action = None
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("请求超过 64 KiB")
        request = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(request, dict):
            raise ValueError("请求必须是 JSON 对象")
        action = request.get("action", request.get("operation"))
        handlers = {"status": lambda _: status(), "properties": properties, "retrosynthesis": retrosynthesis}
        if action not in handlers:
            raise ValueError("不支持的操作")
        # Third-party output never contaminates the single JSON response on stdout.
        with contextlib.redirect_stdout(sys.stderr):
            answer = handlers[action](request)
    except Exception as error:
        code = "RDKIT_NOT_READY" if str(error) == "RDKIT_NOT_READY" else "INVALID_REQUEST" if isinstance(error, (ValueError, TypeError, KeyError)) else "CHEMISTRY_ERROR"
        answer = {"ok": False, "action": action, "code": code, "message": str(error)}
        if action == "retrosynthesis":
            answer.update({"runId": None, "logDirectory": None})
        print(str(error), file=sys.stderr)
    sys.stdout.write(json.dumps(answer, ensure_ascii=False, allow_nan=False) + "\n")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    main()
