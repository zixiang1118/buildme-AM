import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

const ALIASES = { "样本": "sampleId", "样本编号": "sampleId", "样品": "sampleId", "样品编号": "sampleId", "浓度": "concentration", "读数": "value", "数值": "value", "响应": "value", "重复": "replicate", "组别": "group" };

export function parseDelimited(text, delimiter = ",") {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field); if (row.some((value) => value.trim())) rows.push(row); row = []; field = "";
    } else field += char;
    if (rows.length > 100000) throw new Error("单次导入最多 10 万行，请拆分为不同实验记录。");
  }
  if (quoted) throw new Error("CSV 引号没有闭合。");
  row.push(field); if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function assayRows(rows) {
  const headers = (rows[0] ?? []).map((value) => {
    const key = String(value ?? "").replace(/^\uFEFF/u, "").trim();
    return ALIASES[key] || ({ sampleid: "sampleId", concentration: "concentration", value: "value", replicate: "replicate", group: "group" })[key.toLowerCase()] || key;
  });
  if (!headers.includes("sampleId") || !headers.includes("value")) throw new Error("首行需包含 sampleId（样品编号）和 value（读数）。请为技术重复使用同一个样品编号。");
  if (new Set(headers).size !== headers.length) throw new Error("数据表存在重复列名。");
  const numeric = (value, field, line) => {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(number)) throw new Error(`第 ${line} 行 ${field} 不是数值；未检出或低于定量限的结果请保留原资料，并在数值列留空。`);
    return number;
  };
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.every((value) => value == null || String(value).trim() === "")) continue;
    if (cells.length > headers.length) throw new Error(`第 ${i + 1} 行列数超过表头。`);
    const data = Object.fromEntries(headers.map((key, index) => [key, cells[index] ?? null]));
    const sampleId = String(data.sampleId ?? "").trim();
    if (!sampleId) throw new Error(`第 ${i + 1} 行缺少样品编号，无法判定重复检测关系。`);
    records.push({ sampleId, value: numeric(data.value, "value", i + 1), concentration: numeric(data.concentration, "concentration", i + 1),
      replicate: numeric(data.replicate, "replicate", i + 1), group: String(data.group ?? "").trim() });
  }
  if (!records.length) throw new Error("文件没有实验数据行。");
  return records;
}

export async function readAssayFile(path) {
  const info = await stat(path);
  if (info.size > 20 * 1024 * 1024) throw new Error("单次检测表导入最多 20 MiB；更大的原始资料可作为附件归档。");
  const extension = extname(path).toLowerCase();
  let rows;
  if (extension === ".xlsx") {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const sheet = workbook.worksheets.find((item) => item.actualRowCount > 0);
    if (!sheet) throw new Error("Excel 工作簿没有数据页。");
    if (sheet.rowCount > 100000 || sheet.columnCount > 200) throw new Error("请选择最多 10 万行、200 列的检测数据表。");
    rows = [];
    for (let i = 1; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i), values = [];
      for (let j = 1; j <= sheet.columnCount; j++) {
        const value = row.getCell(j).value;
        if (value && typeof value === "object") throw new Error(`Excel ${sheet.name} 第 ${i} 行第 ${j} 列含公式或复杂单元格；请粘贴为值后导入。`);
        values.push(value);
      }
      rows.push(values);
    }
  } else if ([".csv", ".tsv", ".txt"].includes(extension)) {
    const bytes = await readFile(path);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
    rows = parseDelimited(text, extension === ".tsv" || text.split(/\r?\n/u)[0].includes("\t") ? "\t" : ",");
  } else throw new Error("检测数据导入支持 CSV、TSV 和 XLSX。其他格式可作为原始附件归档。");
  return assayRows(rows);
}
