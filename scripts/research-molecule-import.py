#!/usr/bin/env python3
"""Read local molecular exchange files; never run code embedded in them."""
import contextlib
import json
from pathlib import Path
import sys


def read_molecules(request):
    from rdkit import Chem
    path = Path(request["filePath"])
    if not path.is_file() or path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError("结构文件必须是 10 MiB 以内的本地文件")
    if path.suffix.lower() == ".sdf":
        supplier = Chem.SDMolSupplier(str(path), removeHs=False)
        pairs = ((index + 1, mol) for index, mol in enumerate(supplier))
    elif path.suffix.lower() == ".mol":
        pairs = [(1, Chem.MolFromMolFile(str(path), removeHs=False))]
    elif path.suffix.lower() in (".smi", ".smiles"):
        pairs = []
        for index, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines()):
            if not line.strip():
                continue
            fields = line.strip().split(maxsplit=1)
            molecule = Chem.MolFromSmiles(fields[0])
            if molecule is not None and len(fields) > 1:
                molecule.SetProp("_Name", fields[1])
            pairs.append((index + 1, molecule))
    else:
        raise ValueError("支持 MOL、SDF、SMI 和 SMILES 文件")
    molecules, invalid = [], []
    for index, mol in pairs:
        if len(molecules) + len(invalid) >= 100:
            raise ValueError("一次最多导入 100 个结构，请拆分结构库")
        if mol is None or mol.GetNumAtoms() == 0:
            invalid.append(index)
            continue
        molecules.append({"name": mol.GetProp("_Name") if mol.HasProp("_Name") and mol.GetProp("_Name").strip() else f"{path.stem}-{index}",
                          "smiles": Chem.MolToCXSmiles(mol), "sourceRecord": index,
                          "stereo": "立体化学按导入文件保留；未指定部分仍需实验指认"})
    if not molecules:
        raise ValueError("文件没有成功解析的分子结构")
    return {"ok": True, "molecules": molecules, "invalidRecords": invalid}


try:
    data = sys.stdin.buffer.read(65537)
    if len(data) > 65536:
        raise ValueError("导入请求过大")
    with contextlib.redirect_stdout(sys.stderr):
        result = read_molecules(json.loads(data.decode("utf-8-sig")))
except Exception as error:
    result = {"ok": False, "message": str(error)}
sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
