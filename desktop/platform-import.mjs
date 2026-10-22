import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export function parseTable(text, delimiter = ",") {
  const rows = []; let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && char === delimiter) { row.push(value); value = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(value); if (row.some(item => String(item).trim())) rows.push(row); row = []; value = "";
    } else value += char;
    if (rows.length > 20000) throw new Error("单次最多导入 2 万条记录，请拆分文件。");
  }
  if (quoted) throw new Error("数据表的引号没有闭合。");
  row.push(value); if (row.some(item => String(item).trim())) rows.push(row);
  return rows;
}

export async function readPlatformTable(path) {
  if ((await stat(path)).size > 20 * 1024 * 1024) throw new Error("数据表不能超过 20 MiB；大文件可作为附件保存。");
  const extension = extname(path).toLowerCase(); let rows;
  if (extension === ".xlsx") {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path);
    const sheet = workbook.worksheets.find(item => item.actualRowCount > 0);
    if (!sheet || sheet.rowCount > 20001 || sheet.columnCount > 100) throw new Error("请选择有数据且不超过 2 万行、100 列的工作表。");
    rows = [];
    for (let i = 1; i <= sheet.rowCount; i++) {
      const values = [];
      for (let j = 1; j <= sheet.columnCount; j++) {
        const value = sheet.getRow(i).getCell(j).value;
        if (value instanceof Date) values.push(value.toISOString().slice(0, 10));
        else if (value && typeof value === "object") throw new Error(`第 ${i} 行第 ${j} 列含公式或复杂单元格，请先粘贴为值。`);
        else values.push(value);
      }
      if (values.some(value => value !== null && value !== undefined && String(value).trim())) rows.push(values);
    }
  } else if ([".csv", ".tsv", ".txt"].includes(extension)) {
    const bytes = await readFile(path); let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
    rows = parseTable(text, extension === ".tsv" || text.split(/\r?\n/u)[0].includes("\t") ? "\t" : ",");
  } else throw new Error("数据导入支持 CSV、TSV、XLSX，其他文件可作为附件保存。");
  const headers = (rows.shift() || []).map(value => String(value ?? "").replace(/^\uFEFF/u, "").trim());
  if (!headers.length || headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error("数据表需要非空且不重复的列名。");
  if (!rows.length) throw new Error("数据表没有记录。");
  if (rows.some(row => row.length > headers.length)) throw new Error("部分数据行的列数超过表头。");
  return { headers, rows };
}

export function mapPlatformRows(table, page) {
  const fields = page.fields || [], mappings = table.headers.map(header => fields.find(field => field.id.toLowerCase() === header.toLowerCase() || field.label.toLowerCase() === header.toLowerCase()));
  if (!mappings.some(Boolean)) throw new Error("文件列名与平台字段不匹配，请先在搭建器中添加或调整同名字段。");
  const mapped = mappings.filter(Boolean).map(field => field.id);
  if (new Set(mapped).size !== mapped.length) throw new Error("多列映射到同一个字段，请调整列名。");
  const rows = table.rows.map((row, index) => Object.fromEntries(mappings.flatMap((field, column) => {
    if (!field) return [];
    const value = row[column];
    if (value === null || value === undefined || String(value).trim() === "") return [[field.id, null]];
    if (field.type === "number") {
      const number = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(number)) throw new Error(`第 ${index + 2} 行「${field.label}」不是有效数值；缺失值请留空。`);
      return [[field.id, number]];
    }
    return [[field.id, String(value).trim()]];
  })));
  return { rows, warnings: mappings.flatMap((field, index) => field ? [] : [`未导入未配置的列：${table.headers[index]}`]) };
}
