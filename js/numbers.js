// Numbers to words, American style ("one hundred twenty-three", no "and").

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];

function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], "hundred"); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "")); }
  else if (n > 0 || !out.length) out.push(ONES[n]);
  return out.join(" ");
}

export function cardinal(n) {
  if (typeof n === "string") n = Number(n);
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return "minus " + cardinal(-n);
  if (!Number.isInteger(n)) {
    const [w, f] = String(n).split(".");
    return cardinal(Number(w)) + " point " + [...f].map((d) => ONES[+d]).join(" ");
  }
  if (n < 1000) return under1000(n);
  const out = [];
  for (const [v, name] of SCALES) {
    if (n >= v) { out.push(cardinal(Math.floor(n / v)) + " " + name); n %= v; }
  }
  if (n > 0) out.push(under1000(n));
  return out.join(" ");
}

const ORD_IRREG = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
export function ordinal(n) {
  const c = cardinal(n);
  const m = c.match(/^(.*?)([a-z]+)$/);
  const [pre, last] = [m[1], m[2]];
  let o;
  if (ORD_IRREG[last]) o = ORD_IRREG[last];
  else if (last.endsWith("y")) o = last.slice(0, -1) + "ieth";
  else o = last + "th";
  return pre + o;
}

export function yearWords(y) {
  if (y >= 2000 && y <= 2009) return cardinal(y);
  if (y % 1000 === 0) return cardinal(y);
  const hi = Math.floor(y / 100), lo = y % 100;
  if (lo === 0) return cardinal(hi) + " hundred";
  if (lo < 10) return cardinal(hi) + " oh " + ONES[lo];
  return cardinal(hi) + " " + cardinal(lo);
}
