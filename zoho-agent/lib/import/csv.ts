export type ParsedDelimited = {
  columns: string[];
  rows: Record<string, string>[];
  warnings: string[];
};

function detectDelimiter(text: string) {
  const sample = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const commaCount = (sample.match(/,/g) ?? []).length;
  const tabCount = (sample.match(/\t/g) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseRows(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(value.trim());
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  row.push(value.trim());
  if (row.some((cell) => cell.length > 0)) rows.push(row);

  return rows;
}

export function parseDelimitedText(text: string): ParsedDelimited {
  const warnings: string[] = [];
  const delimiter = detectDelimiter(text);
  const rawRows = parseRows(text, delimiter);

  if (rawRows.length === 0) {
    return { columns: [], rows: [], warnings: ["The file did not contain any rows."] };
  }

  const columns = rawRows[0].map((column, index) => column || `Column ${index + 1}`);
  const seen = new Set<string>();
  const duplicates = columns.filter((column) => {
    const key = column.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });

  if (duplicates.length > 0) {
    warnings.push(`Duplicate headers detected: ${duplicates.join(", ")}.`);
  }

  const rows = rawRows.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = cells[index] ?? "";
    });
    return row;
  });

  if (rows.length === 0) {
    warnings.push("Only a header row was found.");
  }

  return { columns, rows, warnings };
}

export function extractMarkdownSections(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, ""));
}
