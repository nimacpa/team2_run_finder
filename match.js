/* Matching engine: turns raw OCR text into a best-guess run number,
   using the embedded PARCEL_RUNS street/range data. Fully offline, no deps. */

(function (global) {
  const RUNS = global.PARCEL_RUNS || [];

  // ---- unique street list (case-insensitive) built once ----
  const streetMap = new Map(); // normalizedName -> { display, rows: [rowsFromRUNS] }
  RUNS.forEach((row) => {
    const key = normalizeStreet(row.street);
    if (!streetMap.has(key)) {
      streetMap.set(key, { display: row.street, key, rows: [] });
    }
    streetMap.get(key).rows.push(row);
  });
  const ALL_STREETS = Array.from(streetMap.values()).sort((a, b) =>
    a.display.localeCompare(b.display)
  );

  const SUFFIX_MAP = {
    AVENUE: 'AVE',
    BOULEVARD: 'BVD',
    CIRCUIT: 'CCT',
    CLOSE: 'CL',
    COURT: 'CT',
    DRIVE: 'DR',
    GROVE: 'GR',
    GATE: 'GTE',
    PARADE: 'PDE',
    PARKWAY: 'PKWY',
    PLACE: 'PL',
    ROAD: 'RD',
    SQUARE: 'SQ',
    STREET: 'ST',
    TERRACE: 'TCE',
    HIGHWAY: 'HWY',
  };

  function normalizeStreet(s) {
    if (!s) return '';
    let t = s.toUpperCase();
    t = t.replace(/[^A-Z0-9 ]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function expandSuffix(normalized) {
    const words = normalized.split(' ');
    const last = words[words.length - 1];
    if (SUFFIX_MAP[last]) {
      words[words.length - 1] = SUFFIX_MAP[last];
      return words.join(' ');
    }
    return normalized;
  }

  // classic Levenshtein distance
  function levenshtein(a, b) {
    const m = a.length,
      n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(
          dp[j] + 1,
          dp[j - 1] + 1,
          prev + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        prev = tmp;
      }
    }
    return dp[n];
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - dist / maxLen;
  }

  // score a candidate text string against a street's normalized name,
  // trying both the raw normalized form and the suffix-expanded form
  function scoreAgainstStreet(candidateNorm, streetKey) {
    const candExpanded = expandSuffix(candidateNorm);
    const streetExpanded = expandSuffix(streetKey);
    return Math.max(
      similarity(candidateNorm, streetKey),
      similarity(candExpanded, streetExpanded),
      similarity(candExpanded, streetKey),
      similarity(candidateNorm, streetExpanded)
    );
  }

  // ---- extract (number, streetTextCandidates) pairs from raw OCR text ----
  function extractCandidates(ocrText) {
    const candidates = [];
    const lines = ocrText.split(/\n/).map((l) => l.trim()).filter(Boolean);

    lines.forEach((line) => {
      // find every number token in the line, with the words that follow it
      const tokenRe = /(\d{1,5}[A-Za-z]?)/g;
      let match;
      while ((match = tokenRe.exec(line)) !== null) {
        const numberToken = match[1];
        const numVal = parseInt(numberToken, 10);
        if (!numVal || numVal <= 0 || numVal > 99999) continue;

        const after = line.slice(match.index + numberToken.length);
        const words = after
          .replace(/[^A-Za-z' ]/g, ' ')
          .trim()
          .split(/\s+/)
          .filter((w) => w.length >= 2);

        // also handle "2/12" style: number before slash is unit, take next number too
        const slashMatch = /^\s*\/\s*(\d{1,5}[A-Za-z]?)/.exec(after);
        let effectiveNum = numVal;
        let effectiveWords = words;
        if (slashMatch) {
          effectiveNum = parseInt(slashMatch[1], 10);
          const after2 = after.slice(slashMatch.index + slashMatch[0].length);
          effectiveWords = after2
            .replace(/[^A-Za-z' ]/g, ' ')
            .trim()
            .split(/\s+/)
            .filter((w) => w.length >= 2);
        }

        for (let winSize = Math.min(4, effectiveWords.length); winSize >= 1; winSize--) {
          const text = effectiveWords.slice(0, winSize).join(' ');
          if (text) candidates.push({ number: effectiveNum, text, line });
        }
        // also keep the un-slashed interpretation as a fallback candidate
        if (slashMatch) {
          for (let winSize = Math.min(4, words.length); winSize >= 1; winSize--) {
            const text = words.slice(0, winSize).join(' ');
            if (text) candidates.push({ number: numVal, text, line });
          }
        }
      }
    });
    return candidates;
  }

  // finds the best street match(es) for the OCR text.
  // returns { best, secondBest, number, allTop, ocrText }
  function findBestMatch(ocrText) {
    const candidates = extractCandidates(ocrText);
    let scored = [];

    candidates.forEach((c) => {
      const candNorm = normalizeStreet(c.text);
      if (!candNorm) return;
      ALL_STREETS.forEach((street) => {
        const score = scoreAgainstStreet(candNorm, street.key);
        scored.push({ score, street, number: c.number, matchedText: c.text });
      });
    });

    if (scored.length === 0) {
      return { best: null, secondBest: null, allTop: [], ocrText };
    }

    scored.sort((a, b) => b.score - a.score);

    // de-duplicate by street, keeping the highest-scoring occurrence
    const seen = new Set();
    const deduped = [];
    for (const s of scored) {
      if (seen.has(s.street.key)) continue;
      seen.add(s.street.key);
      deduped.push(s);
      if (deduped.length >= 8) break;
    }

    return {
      best: deduped[0] || null,
      secondBest: deduped[1] || null,
      allTop: deduped,
      ocrText,
    };
  }

  // ---- resolve a house number against a street's range rows ----
  function resolveRun(street, number) {
    if (!street || !number) return { status: 'no-number', matches: [] };
    const isOdd = number % 2 === 1;
    const parityOk = (p) => p === 'any' || (p === 'odd' && isOdd) || (p === 'even' && !isOdd);

    const matchingRows = [];
    street.rows.forEach((row) => {
      const hit = row.ranges.some((r) => {
        if (r.type === 'any') return true;
        if (r.type === 'single') return r.value === number && parityOk(r.parity || 'any');
        if (r.type === 'range') return number >= r.start && number <= r.end && parityOk(r.parity);
        return false; // 'special' clauses are never auto-matched
      });
      if (hit) matchingRows.push(row);
    });

    if (matchingRows.length === 1) {
      return { status: 'matched', matches: matchingRows };
    } else if (matchingRows.length > 1) {
      return { status: 'multiple', matches: matchingRows };
    } else {
      // no numeric range matched - still return all rows for this street so
      // the user can sanity-check (e.g. number was misread, or it falls in
      // a 'special'/Lot clause)
      return { status: 'no-range-match', matches: street.rows };
    }
  }

  global.ParcelMatch = {
    ALL_STREETS,
    normalizeStreet,
    findBestMatch,
    resolveRun,
    similarity,
    scoreAgainstStreet,
  };
})(window);
