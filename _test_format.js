/**
 * Reproduces the "0.00" formatting bug in the site's own formatAmount().
 *
 * Transcribed from _next/static/chunks/3afhs_vz7l64i.js. The guard silently
 * returns "0.00" for any input that is not plain decimal digits, which is why
 * a large balance used to render as zero.
 */
function formatAmount(e, t = 2) {
  let s = ("number" == typeof e ? e.toString() : e).trim();
  let r = s.startsWith("-");
  let [a = "", l = ""] = (r ? s.slice(1) : s).split(".");
  if (!/^\d*$/.test(a) || !/^\d*$/.test(l) || "" == `${a}${l}`) {
    return t > 0 ? `0.${"0".repeat(t)}` : "0";
  }
  let n = l.slice(0, t).padEnd(t, "0");
  let i = (l.charCodeAt(t) || 0) >= 53;
  let o = `${"" === a ? "0" : a}${n}`;
  if (i) {
    o = (function (e) {
      let t = e.split(""), s = t.length - 1;
      for (; s >= 0; s--) if ("9" === t[s]) t[s] = "0";
      else { t[s] = String(Number(t[s]) + 1); break }
      return s < 0 && t.unshift("1"), t.join("");
    })(o);
  }
  let m = t > 0 ? o.slice(o.length - t) : "";
  let c = ((t > 0 ? o.slice(0, o.length - t) : o) || "0").replace(/^0+(?=\d)/, "");
  let d = c.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let x = /^0+$/.test(c) && /^0*$/.test(m);
  return `${r && !x ? "-" : ""}${d}${m ? `.${m}` : ""}`;
}

let failed = 0;
const bad = [];
function probe(input, note) {
  const out = formatAmount(input);
  const broke = out === "0.00" || out === "0";
  if (broke) bad.push({ input: String(input), out, note });
  console.log(`  ${broke ? 'BREAKS' : 'ok   '}  ${JSON.stringify(String(input)).padEnd(26)} -> ${out.padEnd(18)} ${note || ''}`);
}

console.log('values that make the site render 0.00:\n');
probe("2043.31", "normal");
probe("7000000.00", "string, plain decimal");
probe(7000000, "number");
probe(6999999.99, "the credited amount");
probe("7,000,000.00", "thousand separators");
probe("1e+21", "exponential, big");
probe(1e21, "exponential from toString()");
probe(1e-7, "exponential, tiny");
probe((1e21).toFixed(2), "toFixed of 1e21");
probe("abc", "garbage");
probe("", "empty string");
probe(undefined, "undefined");

console.log(`\n${bad.length} input shape(s) collapse to 0.00`);
if (bad.length) {
  console.log('\nroot causes:');
  const notes = [...new Set(bad.map((b) => b.note))];
  for (const n of notes) console.log('  -', n);
  process.exit(1);
}
console.log('\nno zero-collapse found');
process.exit(0);