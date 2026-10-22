#!/usr/bin/env python3
"""Verify the packaged source structure and observable local chemistry behavior."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return dotted_name(node.value) + "." + node.attr
    return ""


def verify_sources(root: Path) -> dict:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    ids = set()
    hashes = {}
    script_reviews = []
    for skill in manifest["skills"]:
        assert skill["id"] not in ids, "Duplicate skill ID"
        ids.add(skill["id"])
        directory = (root / skill["path"]).resolve()
        assert directory.is_relative_to(root.resolve()), "Skill path escapes bundle"
        entrypoint = directory / "SKILL.md"
        content = entrypoint.read_text(encoding="utf-8")
        assert content.startswith("---\n"), "Missing frontmatter: " + skill["id"]
        assert re.search(r"^name:\s*" + re.escape(skill["name"]) + r"\s*$", content, re.M), "Wrong skill name"
        assert re.search(r"^description:", content, re.M), "Missing description"
        if skill["commit"]:
            assert re.fullmatch(r"[0-9a-f]{40}", skill["commit"]), "Unpinned upstream commit"
            assert skill["commit"] in skill["source"], "Source URL does not match commit"
        for path in sorted(directory.rglob("*")):
            assert not path.is_symlink(), "Symlink in skill package"
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            if path.suffix == ".json":
                json.loads(path.read_text(encoding="utf-8"))
            if path.suffix != ".py":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
            imports = set()
            dangerous = []
            reviewed_constant_imports = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imports.update(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imports.add(node.module)
                elif isinstance(node, ast.Call):
                    name = dotted_name(node.func)
                    if name == "__import__" and len(node.args) == 1 and isinstance(node.args[0], ast.Constant) and node.args[0].value == "pathlib":
                        reviewed_constant_imports.append({"line": node.lineno, "module": "pathlib", "purpose": "Resolve the current script directory for local shared modules"})
                        continue
                    if name in {"eval", "exec", "__import__", "os.system", "os.popen", "pickle.load", "pickle.loads", "yaml.load"} or name.startswith("subprocess.") or name.endswith(".urlopen") or name.startswith("requests."):
                        dangerous.append({"line": node.lineno, "call": name})
            assert not dangerous, "Review required for execution/network call: " + relative
            script_reviews.append({"path": relative, "imports": sorted(imports), "executionOrNetworkCallsDetected": dangerous, "reviewedConstantImports": reviewed_constant_imports})
    for license_path in manifest["sourceLicenses"]:
        text = (root / license_path).read_text(encoding="utf-8")
        assert "Copyright" in text or "copyright" in text
        assert any(label in text for label in ("MIT License", "BSD 3-Clause License", "Apache License"))
    return {"skills": len(ids), "files": len(hashes), "sha256": hashes, "scriptReviews": script_reviews, "scope": "AST parses every bundled script and screens direct network/dynamic execution calls; this is not validation of scientific accuracy or third-party package internals."}


def verify_bridge(python: str, root: Path) -> dict:
    script = root.parents[1] / "scripts" / "research-chemistry.py"

    def invoke(request: dict) -> dict:
        run = subprocess.run([python, str(script)], input=json.dumps(request), text=True, encoding="utf-8", capture_output=True, timeout=30)
        assert run.returncode == 0, run.stderr
        output = json.loads(run.stdout)
        assert isinstance(output, dict), "Bridge must emit one JSON object"
        return output

    current = invoke({"action": "status"})
    assert current["rdkit"]["ready"]
    aspirin = invoke({"action": "properties", "smiles": "CC(=O)Oc1ccccc1C(=O)O"})
    assert aspirin["ok"] and aspirin["provenance"] == "computed"
    assert 180.0 < aspirin["descriptors"]["molecularWeight"] < 180.3
    assert aspirin["descriptors"]["molecularFormula"] == "C9H8O4"
    assert "<svg" in aspirin["svg"] and "</svg>" in aspirin["svg"]
    invalid = invoke({"action": "properties", "smiles": "not-a-molecule; $(echo unsafe)"})
    assert not invalid["ok"] and invalid["code"] == "INVALID_REQUEST"
    left = invoke({"action": "properties", "smiles": "C[C@H](O)C(=O)O"})
    right = invoke({"action": "properties", "smiles": "C[C@@H](O)C(=O)O"})
    assert left["ok"] and right["ok"]
    assert left["canonicalSmiles"] != right["canonicalSmiles"]
    assert left["stereochemistry"]["chiralCenters"][0]["label"] != right["stereochemistry"]["chiralCenters"][0]["label"]
    unspecified = invoke({"action": "properties", "smiles": "CC(O)C(=O)O"})
    assert any(center["label"] == "?" for center in unspecified["stereochemistry"]["chiralCenters"])
    salt = invoke({"action": "properties", "smiles": "CC(=O)[O-].[Na+]"})
    assert salt["ok"] and "." in salt["canonicalSmiles"] and salt["normalization"]["desalted"] is False
    assert salt["warnings"]
    with tempfile.TemporaryDirectory(prefix="buildme-research-not-ready-") as isolated:
        isolated_config = Path(isolated) / "config.json"
        isolated_config.write_text("{}", encoding="utf-8")
        run = subprocess.run([python, str(script)], input=json.dumps({"action": "retrosynthesis", "smiles": "CCO"}), text=True, encoding="utf-8", capture_output=True, timeout=30, env={**os.environ, "BUILDME_RESEARCH_RUNTIME_CONFIG": str(isolated_config)})
        unavailable = json.loads(run.stdout)
    assert not unavailable["ok"] and unavailable["code"] == "RETROSYNTHESIS_NOT_READY" and unavailable["routes"] == []
    return {"cases": ["runtime status", "aspirin formula/mass and SVG", "invalid input without command execution", "opposite stereoisomers remain distinct", "unspecified stereo preserved", "salt fragments preserved", "unconfigured retrosynthesis returns no route"], "status": current, "retrosynthesisExecutionVerified": False}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", help="Existing local chemistry environment interpreter")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    result = {"sourceReview": verify_sources(root)}
    if args.python:
        result["chemistryVerification"] = verify_bridge(args.python, root)
    (root / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "skills": result["sourceReview"]["skills"], "files": result["sourceReview"]["files"], "scripts": len(result["sourceReview"]["scriptReviews"]), "chemistryVerified": bool(args.python)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
