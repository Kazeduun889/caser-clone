/**
 * Reports where the brace depth goes wrong, so a syntax error can be located
 * without bisecting the file by hand.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'server.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

let depth = 0;
const open = [];
const problems = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let inStr = null;
  let inComment = false;

  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    const next = line[j + 1];

    if (inComment) break;
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/') break;
    if (c === '/' && next === '*') { inComment = true; j++; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }

    if (c === '{') { depth++; open.push(i + 1); }
    if (c === '}') {
      depth--;
      if (depth < 0) { problems.push('лишняя } на строке ' + (i + 1)); depth = 0; }
      else open.pop();
    }
  }
}

console.log('файл:', file);
console.log('строк:', lines.length);
console.log('итоговая глубина:', depth);
if (open.length) {
  console.log('незакрытые блоки, самые ранние:', open.slice(0, 8).join(', '));
  for (const lineNo of open.slice(0, 4)) {
    console.log('  ' + lineNo + ': ' + lines[lineNo - 1].trim().slice(0, 90));
  }
}
problems.forEach((p) => console.log(p));