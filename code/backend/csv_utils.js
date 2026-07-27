// csv_utils.js – CSV parser with EUC-KR encoding support

const iconv = require('iconv-lite');

function parseCSV(buffer) {
  // Try UTF-8 first, fall back to EUC-KR
  let csvText = buffer.toString('utf8');

  // Detect if it's garbled (EUC-KR files read as UTF-8 produce lots of replacement chars)
  const replacementCount = (csvText.match(/\uFFFD/g) || []).length;
  if (replacementCount > 5 || !isValidUTF8(csvText)) {
    csvText = iconv.decode(buffer, 'euc-kr');
  }

  // Strip BOM (utf-8-sig files)
  if (csvText.charCodeAt(0) === 0xFEFF) {
    csvText = csvText.slice(1);
  }

  const records = parseCSVText(csvText.trim());
  if (records.length === 0) return [];
  const header = records[0];
  const rows = [];
  for (let i = 1; i < records.length; i++) {
    const values = records[i];
    if (values.length === 1 && values[0].trim() === '') continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = values[j] !== undefined ? values[j].trim() : '';
    }
    rows.push(obj);
  }
  return rows;
}

// Full-text CSV parser: handles quoted fields, escaped quotes, and newlines inside quotes
function parseCSVText(text) {
  const records = [];
  let row = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push(current);
        current = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(current);
        current = '';
        records.push(row);
        row = [];
      } else {
        current += char;
      }
    }
  }
  row.push(current);
  records.push(row);
  return records;
}

function isValidUTF8(str) {
  // Check for common garbled patterns (high byte sequences that aren't valid UTF-8)
  const suspiciousPattern = /[\x80-\xff]{4,}/;
  return !suspiciousPattern.test(str);
}

module.exports = { parseCSV };
