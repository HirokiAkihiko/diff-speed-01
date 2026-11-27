// A faster drop-in for makefun-diff 1.0.0.
//
// The answer is makefun-diff's own patch of { old, new }: a header line
// makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I, then one
// hunk line @ os ol ns nl per hunk, then the hunk's lines, = kept,
// - deleted, + inserted. Lines are cut after every \n only, so a \r is
// part of a line and a last line with no \n is a line too; a line
// without its newline is written with one added and a % line after it.
//
// The script is Myers's greedy search with the reference's own rules:
// the common prefix first, then the common suffix of what is left,
// then the search, which on each diagonal keeps the path that reaches
// furthest into the old text and, when a deletion and an insertion
// reach the same point, takes the deletion's, never moves past either
// text's end, and follows every run of equal lines as far as it goes.
// This implementation returns exactly that script, faster, in two ways:
//
//  1. Lines are interned to small integers before the search, so the
//     search compares integers instead of strings. A line with its \n
//     and the same text without it are different lines and get
//     different ids.
//  2. The search is pruned to the diagonals that can still reach the
//     end within a budget U. U is the cost of a script built from the
//     lines that occur exactly once in each middle slice: their
//     longest increasing subsequence (by the new text's order) is kept
//     as anchors, and every segment between anchors is priced exactly
//     with a small LCS dynamic program. Any valid script costs at
//     least the optimum, so U never sits below it, and the pruned
//     search finds exactly the unpruned search's first path. When the
//     anchors are too sparse, or the pruned search does not finish by
//     U, the plain unpruned search runs instead.
//
// The V rows of the pruned search live in one flat buffer, pruned
// widths, two padding cells a side, so a candidate diagonal outside
// the previous row's range reads zero instead of a stale value.
const KEEP = 0, DEL = 1, INS = 2;

function tokenizeIds(text, dictNl, dictBare, pool) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const ids = new Int32Array(last + (parts[last] === '' ? 0 : 1));
  let w = 0;
  for (let i = 0; i < last; i++) {
    const line = parts[i];
    let id = dictNl.get(line);
    if (id === undefined) { id = pool.length; dictNl.set(line, id); pool.push(line + '\n'); }
    ids[w++] = id;
  }
  if (parts[last] !== '') {
    const line = parts[last];
    let id = dictBare.get(line);
    if (id === undefined) { id = pool.length; dictBare.set(line, id); pool.push(line); }
    ids[w++] = id;
  }
  return ids;
}

function pushRun(runs, kind, count) {
  if (count <= 0) return;
  const last = runs[runs.length - 1];
  if (last && last[0] === kind) last[1] += count;
  else runs.push([kind, count]);
}

// Edit cost (deletions + insertions) of two slices, by LCS, reusing
// the caller's row buffers. Returns -1 when the product is too big
// to price cheaply.
function segCost(a, aOff, aLen, b, bOff, bLen, ws) {
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;
  if (aLen * bLen > 100000) return -1;
  if (ws.prev.length < bLen + 1) {
    ws.prev = new Int32Array(bLen + 1);
    ws.cur = new Int32Array(bLen + 1);
  } else {
    ws.prev.fill(0);
    ws.cur.fill(0);
  }
  let prev = ws.prev, cur = ws.cur;
  for (let i = 0; i < aLen; i++) {
    const av = a[aOff + i];
    cur[0] = 0;
    for (let j = 0; j < bLen; j++) {
      cur[j + 1] = av === b[bOff + j] ? prev[j] + 1 : (prev[j + 1] > cur[j] ? prev[j + 1] : cur[j]);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return aLen + bLen - 2 * prev[bLen];
}

// Longest increasing subsequence of the new-text positions of the
// lines that occur once in each middle slice, earliest in the old
// text among the longest: chain lengths from the right (a Fenwick
// tree over distinct-value ranks, so equal values never chain),
// then a greedy walk. Returns the chosen sequence positions.
function lisAnchors(seqB, bLen) {
  const U = seqB.length;
  if (U === 0) return [];
  const present = new Uint8Array(bLen + 1);
  for (let i = 0; i < U; i++) present[seqB[i]] = 1;
  const rankOf = new Int32Array(bLen + 1);
  let r = 1;
  for (let v = bLen; v >= 0; v--) if (present[v]) { rankOf[v] = r; r++; }
  const distinct = r - 1;
  const rankArr = new Int32Array(U);
  for (let i = 0; i < U; i++) rankArr[i] = rankOf[seqB[i]];
  const bit = new Int32Array(distinct + 2);
  const bitQuery = (i) => { let best = 0; for (; i > 0; i -= i & -i) if (bit[i] > best) best = bit[i]; return best; };
  const bitUpdate = (i, v) => { for (; i <= distinct; i += i & -i) if (v > bit[i]) bit[i] = v; };
  const lisFrom = new Int32Array(U);
  let total = 0;
  for (let s = U - 1; s >= 0; s--) {
    const v = 1 + bitQuery(rankArr[s] - 1);
    lisFrom[s] = v;
    if (v > total) total = v;
    bitUpdate(rankArr[s], v);
  }
  const anchors = [];
  let prevB = -1, need = total;
  for (let s = 0; s < U && need > 0; s++) {
    if (seqB[s] > prevB && lisFrom[s] === need) { anchors.push(s); prevB = seqB[s]; need--; }
  }
  return anchors;
}

// Upper bound on the middle slice's edit distance, or -1 when the
// anchors are too sparse to price the segments cheaply.
function upperBound(a, aOff, aLen, b, bOff, bLen, poolSize) {
  if (aLen === 0 || bLen === 0) return aLen + bLen;
  const cntA = new Int32Array(poolSize);
  const cntB = new Int32Array(poolSize);
  for (let i = 0; i < aLen; i++) cntA[a[aOff + i]]++;
  for (let i = 0; i < bLen; i++) cntB[b[bOff + i]]++;
  const posB = new Int32Array(poolSize);
  posB.fill(-1);
  for (let j = 0; j < bLen; j++) {
    const id = b[bOff + j];
    if (cntB[id] === 1) posB[id] = j;
  }
  const seqA = [], seqB = [];
  for (let i = 0; i < aLen; i++) {
    const id = a[aOff + i];
    if (cntA[id] === 1 && cntB[id] === 1) { seqA.push(i); seqB.push(posB[id]); }
  }
  if (seqA.length < 50) return -1;
  const anchors = lisAnchors(seqB, bLen);
  if (anchors.length < seqA.length * 0.4) return -1;
  const ws = { prev: new Int32Array(64), cur: new Int32Array(64) };
  let total = 0, aPrev = 0, bPrev = 0;
  const price = (aEnd, bEnd) => {
    const c = segCost(a, aOff + aPrev, aEnd - aPrev, b, bOff + bPrev, bEnd - bPrev, ws);
    if (c < 0) return false;
    total += c;
    return true;
  };
  for (const s of anchors) {
    if (!price(seqA[s], seqB[s])) return -1;
    aPrev = seqA[s] + 1; bPrev = seqB[s] + 1;
  }
  if (!price(aLen, bLen)) return -1;
  return total;
}

// Myers on a[0..aLen), b[0..bLen); budget <= 0 means the plain
// unpruned search (one row array per step), budget > 0 means the
// pruned search in a single flat buffer. Returns the runs, or null
// when a pruned search does not reach the end by its budget.
function middleRuns(a, aLen, b, bLen, budget) {
  if (aLen === 0) return bLen ? [[INS, bLen]] : [];
  if (bLen === 0) return [[DEL, aLen]];
  if (budget <= 0) return middleRunsRows(a, aLen, b, bLen);
  const kF = aLen - bLen;
  const U = budget;
  // Row geometry for the pruned search: each row's lowest diagonal
  // and its offset into the flat buffer.
  const kLos = new Int32Array(U + 1);
  const offs = new Int32Array(U + 2);
  let total = 0;
  for (let d = 0; d <= U; d++) {
    let kLo = -d, kHi = d;
    if (d > 0) {
      const reach = U - d;
      if (kF - reach > kLo) kLo = kF - reach;
      if (kF + reach < kHi) kHi = kF + reach;
      if (((kLo + d) & 1) !== 0) kLo++;
    }
    kLos[d] = kLo;
    offs[d] = total;
    total += (kHi - kLo) + 5;
  }
  offs[U + 1] = total;
  if (total > 60000000) return null;
  const flat = new Int32Array(total);
  // Step 0: the opening run of equal lines.
  let x = 0;
  while (x < aLen && x < bLen && a[x] === b[x]) x++;
  flat[offs[0] + 2] = x + 1;
  if (x === aLen && x === bLen) return [[KEEP, x]];
  let D = -1;
  outer:
  for (let d = 1; d <= U; d++) {
    const prevOff = offs[d - 1], prevLo = kLos[d - 1];
    const curOff = offs[d], curLo = kLos[d];
    const kHi = curLo + (offs[d + 1] - offs[d] - 5);
    for (let k = curLo, idx = curOff + 2; k <= kHi; k += 2, idx += 2) {
      const delS = flat[prevOff + (k - 1 - prevLo) + 2];
      const insS = flat[prevOff + (k + 1 - prevLo) + 2];
      const bd = (delS !== 0 && delS <= aLen) ? delS : -2;
      const bi = (insS !== 0 && insS - k - 2 < bLen) ? insS - 1 : -2;
      if (bd === -2 && bi === -2) continue;
      const x0 = bd >= bi ? bd : bi;
      let xx = x0, yy = x0 - k;
      while (xx < aLen && yy < bLen && a[xx] === b[yy]) { xx++; yy++; }
      flat[idx] = xx + 1;
      if (xx === aLen && yy === bLen) { D = d; break outer; }
    }
  }
  if (D < 0) return null;
  const segs = [];
  x = aLen;
  let k = aLen - bLen;
  for (let d = D; d >= 1; d--) {
    const prevOff = offs[d - 1], prevLo = kLos[d - 1];
    const delS = flat[prevOff + (k - 1 - prevLo) + 2];
    const insS = flat[prevOff + (k + 1 - prevLo) + 2];
    const bd = (delS !== 0 && delS <= aLen) ? delS : -2;
    const bi = (insS !== 0 && insS - k - 2 < bLen) ? insS - 1 : -2;
    const isDel = bd >= bi;
    const x0 = isDel ? bd : bi;
    const snake = x - x0;
    if (snake > 0) segs.push([KEEP, snake]);
    segs.push([isDel ? DEL : INS, 1]);
    x = isDel ? bd - 1 : bi;
    k = isDel ? k - 1 : k + 1;
  }
  if (x > 0) segs.push([KEEP, x]);
  segs.reverse();
  const runs = [];
  for (const s of segs) pushRun(runs, s[0], s[1]);
  return runs;
}

// The plain unpruned Myers, used when there is no budget or when a
// pruned search gives up. Same tie-break as the reference.
function middleRunsRows(a, aLen, b, bLen) {
  const rows = [];
  let x = 0;
  while (x < aLen && x < bLen && a[x] === b[x]) x++;
  let row = new Int32Array(5);
  row[2] = x + 1;
  rows.push(row);
  if (x === aLen && x === bLen) return [[KEEP, x]];
  let D = -1;
  outer:
  for (let d = 1; d <= aLen + bLen; d++) {
    const prev = rows[d - 1];
    row = new Int32Array(2 * d + 5);
    for (let k = -d, idx = 2; k <= d; k += 2, idx += 2) {
      const delS = prev[idx - 2];
      const insS = prev[idx];
      const bd = (delS !== 0 && delS <= aLen) ? delS : -2;
      const bi = (insS !== 0 && insS - k - 2 < bLen) ? insS - 1 : -2;
      if (bd === -2 && bi === -2) continue;
      const x0 = bd >= bi ? bd : bi;
      let xx = x0, yy = x0 - k;
      while (xx < aLen && yy < bLen && a[xx] === b[yy]) { xx++; yy++; }
      row[idx] = xx + 1;
      if (xx === aLen && yy === bLen) { D = d; rows.push(row); break outer; }
    }
    rows.push(row);
  }
  if (D < 0) throw new Error('search failed');
  const segs = [];
  x = aLen;
  let k = aLen - bLen;
  for (let d = D; d >= 1; d--) {
    const prev = rows[d - 1];
    const idx = k + d + 2;
    const delS = prev[idx - 2];
    const insS = prev[idx];
    const bd = (delS !== 0 && delS <= aLen) ? delS : -2;
    const bi = (insS !== 0 && insS - k - 2 < bLen) ? insS - 1 : -2;
    const isDel = bd >= bi;
    const x0 = isDel ? bd : bi;
    const snake = x - x0;
    if (snake > 0) segs.push([KEEP, snake]);
    segs.push([isDel ? DEL : INS, 1]);
    x = isDel ? bd - 1 : bi;
    k = isDel ? k - 1 : k + 1;
  }
  if (x > 0) segs.push([KEEP, x]);
  segs.reverse();
  const runs = [];
  for (const s of segs) pushRun(runs, s[0], s[1]);
  return runs;
}

export function run(input) {
  if (!input || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('run needs { old, new } strings');
  }
  const dictNl = new Map();
  const dictBare = new Map();
  const pool = [];
  const A = tokenizeIds(input.old, dictNl, dictBare, pool);
  const B = tokenizeIds(input.new, dictNl, dictBare, pool);
  const n = A.length, m = B.length;
  let pre = 0;
  while (pre < n && pre < m && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && A[n - 1 - suf] === B[m - 1 - suf]) suf++;
  const aLen = n - pre - suf, bLen = m - pre - suf;
  const aMid = A.subarray(pre, n - suf);
  const bMid = B.subarray(pre, m - suf);
  let runs = null;
  // The upper bound itself costs a pass over the slices, so it only
  // pays for itself on large middles; smaller ones run the plain
  // search directly.
  if (aLen + bLen > 4000) {
    const U = upperBound(A, pre, aLen, B, pre, bLen, pool.length);
    if (U > 0) runs = middleRuns(aMid, aLen, bMid, bLen, U);
  }
  if (runs === null) runs = middleRuns(aMid, aLen, bMid, bLen, 0);
  const all = [];
  pushRun(all, KEEP, pre);
  for (const r of runs) pushRun(all, r[0], r[1]);
  pushRun(all, KEEP, suf);

  // Runs of changes, then hunks: a hunk shows up to 3 kept lines
  // around each run, and runs at most 6 kept lines apart share one.
  const changes = [];
  let o = 0, p = 0, deleted = 0, inserted = 0;
  for (const [kind, count] of all) {
    if (kind === KEEP) { o += count; p += count; continue; }
    let c = changes[changes.length - 1];
    if (!c || c.o + c.dels !== o || c.p + c.ins !== p) { c = { o, p, dels: 0, ins: 0 }; changes.push(c); }
    if (kind === DEL) { c.dels += count; o += count; deleted += count; }
    else { c.ins += count; p += count; inserted += count; }
  }
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h ? h[h.length - 1] : undefined;
    if (prev && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const emit = (op, line) => {
    if (line.charCodeAt(line.length - 1) === 10) out.push(op + line);
    else out.push(op + line + '\n%\n');
  };
  for (const h of hunks) {
    const first = h[0], last = h[h.length - 1];
    const oldStart = first.o - 3 > 0 ? first.o - 3 : 0;
    const newStart = first.p - (first.o - oldStart);
    const after = n - (last.o + last.dels) < 3 ? n - (last.o + last.dels) : 3;
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      while (at < c.o) { emit('=', pool[A[at]]); at++; }
      for (let i = 0; i < c.dels; i++) emit('-', pool[A[c.o + i]]);
      for (let i = 0; i < c.ins; i++) emit('+', pool[B[c.p + i]]);
      at = c.o + c.dels;
    }
    while (at < oldEnd) { emit('=', pool[A[at]]); at++; }
  }
  return out.join('');
}
