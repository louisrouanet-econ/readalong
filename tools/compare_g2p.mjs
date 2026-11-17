// Compare the browser G2P with misaki (the local app's front end) on reference chunks. Usage: node tools/compare_g2p.mjs ref.json
import { readFileSync } from "node:fs";
import { setDict, pieces, phonemizeWords } from "../js/g2p.js";
setDict(JSON.parse(readFileSync(new URL("../data/dict.json", import.meta.url))));
const ref = JSON.parse(readFileSync(process.argv[2], "utf8"));
let n = 0, same = 0, stressOnly = 0;
const diffs = new Map();
const norm = (s) => s.replace(/[ˈˌ]/g, "");
for (const c of ref) {
  const words = pieces(c.text).filter((p) => p.w).map((p) => p.w);
  const { ps } = await phonemizeWords(words);
  let j = 0;
  for (const [wt, ph] of c.words) {
    let k = -1;
    for (let q = j; q < Math.min(words.length, j + 4); q++) if (words[q].toLowerCase() === wt.toLowerCase()) { k = q; break; }
    if (k < 0) continue;
    j = k + 1; n++;
    const mine = ps[k].replace(/ /g, "");
    const theirs = ph.replace(/ /g, "");
    if (mine === theirs) same++;
    else if (norm(mine) === norm(theirs)) stressOnly++;
    else { const key = `${wt}: misaki ${theirs} | js ${mine}`; diffs.set(key, (diffs.get(key) || 0) + 1); }
  }
}
console.log(`words compared ${n}; identical ${(100 * same / n).toFixed(1)}%; stress-only differences ${(100 * stressOnly / n).toFixed(1)}%; different sounds ${(100 * (n - same - stressOnly) / n).toFixed(1)}%`);
console.log([...diffs].sort((a, b) => b[1] - a[1]).slice(0, +(process.argv[3] || 40)).map(([k, v]) => `${v}x ${k}`).join("\n"));
