#!/usr/bin/env python3
"""Download reviewed public AiZynthFinder data with publisher size/checksum checks."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import urllib.error
import urllib.request

SPECS = [
    {"filename": "uspto_model.onnx", "url": "https://zenodo.org/records/7797465/files/uspto_model.onnx?download=1", "size": 91518243, "md5": "b466a436b6a8eceaba8c14ef5e2a88c8", "source": "https://zenodo.org/records/7797465"},
    {"filename": "uspto_filter_model.onnx", "url": "https://zenodo.org/records/7797465/files/uspto_filter_model.onnx?download=1", "size": 16788859, "md5": "ab0df54b62a0aeceecd68051f8dc3f2e", "source": "https://zenodo.org/records/7797465"},
    {"filename": "uspto_templates.csv.gz", "url": "https://zenodo.org/records/7341155/files/uspto_unique_templates.csv.gz?download=1", "size": 3313598, "md5": "e8fb29d4dcd54073658000e212b7845a", "source": "https://zenodo.org/records/7341155"},
    {"filename": "zinc_stock.hdf5", "url": "https://ndownloader.figshare.com/files/23086469", "size": 663232280, "md5": "00de71724ec1d4a8463c1b0d8a5d0941", "source": "https://figshare.com/articles/dataset/12334577", "stockName": "zinc-public-2020"},
]
for _spec in SPECS:
    _spec["license"] = "MIT" if _spec["filename"] == "zinc_stock.hdf5" else "CC-BY-4.0"


def digest(path: Path) -> tuple[str, str]:
    md5, sha256 = hashlib.md5(), hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            md5.update(chunk)
            sha256.update(chunk)
    return md5.hexdigest(), sha256.hexdigest()


def download(spec: dict, directory: Path, deadline: float) -> dict:
    destination = directory / spec["filename"]
    if destination.is_file() and destination.stat().st_size == spec["size"]:
        md5, sha256 = digest(destination)
        if md5 == spec["md5"]:
            return {**spec, "sha256": sha256, "path": str(destination), "verified": True}
    temporary = destination.with_suffix(destination.suffix + ".part")
    for attempt in range(2):
        if time.monotonic() >= deadline:
            raise TimeoutError("Public data download budget exhausted")
        # Figshare generates a time-limited public S3 URL. A fresh public request
        # avoids an expired cached redirect; no authentication is involved.
        url = spec["url"]
        if "figshare.com" in url:
            url += "?buildme_public_download=" + str(int(time.time()))
        received = temporary.stat().st_size if temporary.is_file() else 0
        headers = {"User-Agent": "BuildMe-Research/1.0"}
        if received:
            headers["Range"] = f"bytes={received}-"
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=25) as response:
                mode = "ab" if received and response.status == 206 else "wb"
                if mode == "wb":
                    received = 0
                last_report = time.monotonic()
                with temporary.open(mode) as handle:
                    while True:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Public data download budget exhausted")
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > spec["size"]:
                            raise ValueError("Publisher size exceeded for " + spec["filename"])
                        handle.write(chunk)
                        if time.monotonic() - last_report >= 20:
                            print(json.dumps({"file": spec["filename"], "bytes": received, "totalBytes": spec["size"]}), flush=True)
                            last_report = time.monotonic()
            if received != spec["size"]:
                raise ValueError("Incomplete public data file: " + spec["filename"])
            md5, sha256 = digest(temporary)
            if md5 != spec["md5"]:
                temporary.unlink()
                raise ValueError("Publisher checksum mismatch for " + spec["filename"])
            temporary.replace(destination)
            print(json.dumps({"file": spec["filename"], "verified": True, "bytes": received}), flush=True)
            return {**spec, "sha256": sha256, "path": str(destination), "verified": True}
        except (urllib.error.URLError, OSError, ValueError) as error:
            print(json.dumps({"file": spec["filename"], "attempt": attempt + 1, "error": str(error)}), flush=True)
            if attempt == 1:
                raise
    raise RuntimeError("Download did not complete")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", default=r"D:\BuildMeResearchRuntime\models")
    parser.add_argument("--deadline-seconds", type=int, default=1200)
    args = parser.parse_args()
    if not 60 <= args.deadline_seconds <= 1800:
        raise ValueError("Download budget must be 60–1800 seconds")
    directory = Path(args.destination).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(directory).free < sum(spec["size"] for spec in SPECS) + 512 * 1024 * 1024:
        raise OSError("Insufficient free space for reviewed public data")
    deadline = time.monotonic() + args.deadline_seconds
    records = []
    for spec in SPECS:
        records.append(download(spec, directory, deadline))
        (directory / "data-provenance.json").write_text(json.dumps({"files": records, "complete": False}, indent=2), encoding="utf-8")
    config = {
        "expansion": {"uspto": {"type": "template-based", "model": str(directory / "uspto_model.onnx"), "template": str(directory / "uspto_templates.csv.gz")}},
        "filter": {"uspto": {"type": "quick-filter", "model": str(directory / "uspto_filter_model.onnx")}},
        "stock": {"zinc-public-2020": {"type": "inchiset", "path": str(directory / "zinc_stock.hdf5")}},
        "search": {"algorithm": "mcts", "time_limit": 60, "iteration_limit": 100, "max_transforms": 6, "return_first": False},
        "post_processing": {"all_routes": True},
    }
    config_path = directory / "config.yml"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    (directory / "data-provenance.json").write_text(json.dumps({"files": records, "complete": True, "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "note": "Public model and stock snapshots; stock membership is not current supplier availability."}, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "configuration": str(config_path), "bytes": sum(spec["size"] for spec in SPECS), "stock": "zinc-public-2020"}), flush=True)


if __name__ == "__main__":
    main()
