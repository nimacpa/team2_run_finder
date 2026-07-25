(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- confidence thresholds ----------
  const MIN_ACCEPT_SCORE = 0.72; // below this, don't even suggest it
  const CONFIDENT_MARGIN = 0.1; // best must beat second-best by this to be "confident"
  const LOW_CONFIDENCE_FLOOR = 0.55; // below this, don't present candidates as "guesses" at all

  // ---------- screens ----------
  const screens = {
    home: $('#screen-home'),
    scanning: $('#screen-scanning'),
    result: $('#screen-result'),
    manual: $('#screen-manual'),
  };
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // ---------- history (session only, in-memory) ----------
  const history = [];
  function pushHistory(entry) {
    history.unshift(entry);
    if (history.length > 8) history.pop();
    renderHistory();
  }
  function renderHistory() {
    const el = $('#history-list');
    el.innerHTML = '';
    if (history.length === 0) {
      $('#history-wrap').classList.add('hidden');
      return;
    }
    $('#history-wrap').classList.remove('hidden');
    history.forEach((h) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="hist-run">${h.run}</span><span class="hist-addr">${h.number} ${h.street}</span>`;
      el.appendChild(li);
    });
  }

  // ---------- camera ----------
  const video = $('#camera-video');
  const canvas = document.createElement('canvas');
  let mediaStream = null;

  async function startCamera() {
    stopCamera();
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = mediaStream;
      await video.play();
      $('#camera-fallback').classList.add('hidden');
      $('#capture-btn').classList.remove('hidden');
    } catch (err) {
      console.warn('getUserMedia failed, falling back to file capture', err);
      $('#camera-fallback').classList.remove('hidden');
      $('#capture-btn').classList.add('hidden');
    }
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  function captureFromVideo() {
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    return canvas;
  }

  function captureFromFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // Grayscale + contrast-stretch the captured photo before OCR. This alone
  // meaningfully improves recognition on uneven lighting, low-contrast pen
  // on paper, and glare - without a hard binarize that can destroy faint strokes.
  function preprocessForOcr(sourceCanvas) {
    const out = document.createElement('canvas');
    out.width = sourceCanvas.width;
    out.height = sourceCanvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);
    const imgData = ctx.getImageData(0, 0, out.width, out.height);
    const d = imgData.data;
    const n = d.length / 4;
    const gray = new Uint8ClampedArray(n);

    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // find robust min/max (1st/99th percentile) to stretch contrast
    const hist = new Array(256).fill(0);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    let cum = 0;
    let lo = 0, hi = 255;
    const loTarget = n * 0.01;
    const hiTarget = n * 0.99;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      if (cum >= loTarget) { lo = v; break; }
    }
    cum = 0;
    for (let v = 255; v >= 0; v--) {
      cum += hist[v];
      if (cum >= n - hiTarget) { hi = v; break; }
    }
    if (hi <= lo) { lo = 0; hi = 255; }
    const range = hi - lo || 1;

    for (let i = 0; i < n; i++) {
      let v = ((gray[i] - lo) / range) * 255;
      v = Math.max(0, Math.min(255, v));
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
    return out;
  }

  // ---------- OCR (tesseract.js, fully local paths) ----------
  let worker = null;
  let workerReady = null;

  function initWorker() {
    if (workerReady) return workerReady;
    $('#scan-status').textContent = 'Loading OCR engine (first time only)…';
    workerReady = Tesseract.createWorker('eng', 1, {
      workerPath: 'vendor/worker.min.js',
      corePath: 'vendor/',
      langPath: 'lang-data/',
      workerBlobURL: false,
    }).then((w) => {
      worker = w;
      return w;
    });
    return workerReady;
  }

  async function runOcr(sourceCanvas) {
    await initWorker();
    $('#scan-status').textContent = 'Reading label…';
    const processed = preprocessForOcr(sourceCanvas);

    // Pass 1: treat the photo as one uniform block of text (best for a tightly
    // framed address block).
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    let { data } = await worker.recognize(processed);
    let text = data.text || '';

    // Pass 2 fallback: if barely anything came back, try fully-automatic
    // layout analysis instead - helps when the frame includes more than just
    // the address (whole label, extra margins, etc).
    if (text.replace(/\s/g, '').length < 6) {
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
      const retry = await worker.recognize(processed);
      if ((retry.data.text || '').replace(/\s/g, '').length > text.replace(/\s/g, '').length) {
        text = retry.data.text || '';
      }
    }
    return text;
  }

  // ---------- main scan flow ----------
  async function handleImageReady(sourceCanvasOrElement) {
    showScreen('scanning');
    const thumb = $('#scan-thumb');
    thumb.src = sourceCanvasOrElement.toDataURL
      ? sourceCanvasOrElement.toDataURL('image/jpeg', 0.85)
      : '';
    stopCamera();

    try {
      const text = await runOcr(sourceCanvasOrElement);
      processOcrText(text);
    } catch (err) {
      console.error(err);
      $('#scan-status').textContent = 'OCR failed: ' + err.message;
      setTimeout(() => {
        openManual('', '');
      }, 1200);
    }
  }

  function processOcrText(text) {
    const result = ParcelMatch.findBestMatch(text);
    if (!result.best || result.best.score < MIN_ACCEPT_SCORE) {
      showResultAmbiguous(text, result);
      return;
    }
    const marginOk =
      !result.secondBest || result.best.score - result.secondBest.score >= CONFIDENT_MARGIN;

    const resolved = ParcelMatch.resolveRun(result.best.street, result.best.number);

    if (marginOk && resolved.status === 'matched') {
      showResultConfident(text, result.best, resolved);
    } else {
      showResultAmbiguous(text, result, resolved);
    }
  }

  // ---------- result rendering ----------
  function showResultConfident(rawText, bestGuess, resolved) {
    const row = resolved.matches[0];
    $('#result-run').textContent = row.run;
    $('#result-status').textContent = 'Match found';
    $('#result-status').className = 'status-pill status-good';
    $('#result-street').textContent = bestGuess.street.display;
    $('#result-detail').textContent = `#${bestGuess.number}` +
      (row.rawRange ? ` — within ${row.rawRange}` : ' — no number restriction') +
      ` (${row.sheet})`;
    $('#result-raw-text').textContent = rawText.trim() || '(no text detected)';
    $('#result-ambiguous-panel').classList.add('hidden');
    pushHistory({ run: row.run, street: bestGuess.street.display, number: bestGuess.number });
    showScreen('result');
  }

  function showResultAmbiguous(rawText, matchResult, resolved) {
    $('#result-run').textContent = '?';
    $('#result-status').textContent = 'Needs your check';
    $('#result-status').className = 'status-pill status-warn';
    $('#result-detail').textContent = '';

    const bestIsPlausible = matchResult && matchResult.best && matchResult.best.score >= LOW_CONFIDENCE_FLOOR;

    if (bestIsPlausible) {
      $('#result-street').textContent = matchResult.best.street.display + ' (best guess)';
    } else {
      $('#result-street').textContent = 'Could not confidently read a street name';
    }
    $('#result-raw-text').textContent = rawText.trim() || '(no text detected - try moving closer / better light)';
    // auto-reveal the raw OCR text whenever we're unsure, so it's obvious
    // whether this is a data problem or an OCR-read problem
    $('#result-raw-wrap').classList.remove('hidden');

    // build candidate chips
    const panel = $('#result-ambiguous-panel');
    panel.classList.remove('hidden');
    const list = $('#ambiguous-candidates');
    list.innerHTML = '';

    const candidates = [];
    if (bestIsPlausible) {
      matchResult.allTop
        .filter((c) => c.score >= LOW_CONFIDENCE_FLOOR)
        .slice(0, 5)
        .forEach((c) => candidates.push({ street: c.street, number: c.number }));
    }
    if (resolved && resolved.matches && matchResult && matchResult.best && bestIsPlausible) {
      // if we had a street match but numbers didn't line up, surface its rows too
      resolved.matches.forEach((row) => {
        if (!candidates.find((c) => c.street.key === matchResult.best.street.key)) {
          candidates.push({ street: matchResult.best.street, number: matchResult.best.number });
        }
      });
    }

    if (candidates.length === 0) {
      list.innerHTML = '<p class="muted">No confident street matches. Check the raw text below, or search manually.</p>';
    } else {
      candidates.forEach((c) => {
        const btn = document.createElement('button');
        btn.className = 'candidate-btn';
        btn.innerHTML = `<strong>${c.street.display}</strong><span>try #${c.number}</span>`;
        btn.addEventListener('click', () => selectStreetAndNumber(c.street, c.number));
        list.appendChild(btn);
      });
    }

    showScreen('result');
  }

  function selectStreetAndNumber(street, number) {
    const resolved = ParcelMatch.resolveRun(street, number);
    if (resolved.status === 'matched') {
      const row = resolved.matches[0];
      $('#result-run').textContent = row.run;
      $('#result-status').textContent = 'Match found';
      $('#result-status').className = 'status-pill status-good';
      $('#result-street').textContent = street.display;
      $('#result-detail').textContent = `#${number}` +
        (row.rawRange ? ` — within ${row.rawRange}` : ' — no number restriction') +
        ` (${row.sheet})`;
      $('#result-ambiguous-panel').classList.add('hidden');
      pushHistory({ run: row.run, street: street.display, number });
    } else {
      // multiple rows or no numeric range hit - let them pick the exact row
      openManual('', String(number), street.display);
    }
  }

  // ---------- manual search screen ----------
  function openManual(prefillQuery, prefillNumber, prefillSelectStreet) {
    showScreen('manual');
    const q = $('#manual-search-input');
    const num = $('#manual-number-input');
    q.value = prefillQuery || '';
    num.value = prefillNumber || '';
    renderManualList(q.value);
    if (prefillSelectStreet) {
      q.value = prefillSelectStreet;
      renderManualList(prefillSelectStreet, true);
    }
  }

  function renderManualList(query, autoOpenExact) {
    const list = $('#manual-street-list');
    list.innerHTML = '';
    const norm = ParcelMatch.normalizeStreet(query || '');
    let streets = ParcelMatch.ALL_STREETS;
    if (norm) {
      streets = streets
        .map((s) => ({ s, score: ParcelMatch.scoreAgainstStreet(norm, s.key) }))
        .filter((x) => x.score > 0.35 || x.s.key.includes(norm) || norm.includes(x.s.key.split(' ')[0]))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s)
        .slice(0, 40);
    } else {
      streets = streets.slice(0, 40);
    }

    if (streets.length === 0) {
      list.innerHTML = '<p class="muted">No streets found. Try a shorter search.</p>';
      return;
    }

    streets.forEach((street) => {
      const item = document.createElement('div');
      item.className = 'manual-street-item';
      const rangesText = street.rows
        .map((r) => (r.rawRange ? r.rawRange : 'no number restriction') + ` → run ${r.run}`)
        .join(' | ');
      item.innerHTML = `<div class="ms-name">${street.display}</div><div class="ms-ranges">${rangesText}</div>`;
      item.addEventListener('click', () => {
        const numVal = parseInt($('#manual-number-input').value, 10);
        if (numVal) {
          selectStreetAndNumber(street, numVal);
          showScreen('result');
        } else if (street.rows.length === 1) {
          const row = street.rows[0];
          $('#result-run').textContent = row.run;
          $('#result-status').textContent = 'Match found';
          $('#result-status').className = 'status-pill status-good';
          $('#result-street').textContent = street.display;
          $('#result-detail').textContent = row.rawRange
            ? `within ${row.rawRange} (${row.sheet})`
            : `no number restriction (${row.sheet})`;
          $('#result-ambiguous-panel').classList.add('hidden');
          pushHistory({ run: row.run, street: street.display, number: '' });
          showScreen('result');
        } else {
          // multiple rows for this street & no number given - let them pick the row directly
          showRowPicker(street);
        }
      });
      list.appendChild(item);
    });
  }

  function showRowPicker(street) {
    const list = $('#manual-street-list');
    list.innerHTML = `<p class="muted">${street.display} has multiple ranges — pick the right one:</p>`;
    street.rows.forEach((row) => {
      const btn = document.createElement('button');
      btn.className = 'candidate-btn';
      btn.innerHTML = `<strong>${row.rawRange || 'no number restriction'}</strong><span>run ${row.run}</span>`;
      btn.addEventListener('click', () => {
        $('#result-run').textContent = row.run;
        $('#result-status').textContent = 'Match found';
        $('#result-status').className = 'status-pill status-good';
        $('#result-street').textContent = street.display;
        $('#result-detail').textContent = row.rawRange
          ? `within ${row.rawRange} (${row.sheet})`
          : `no number restriction (${row.sheet})`;
        $('#result-ambiguous-panel').classList.add('hidden');
        pushHistory({ run: row.run, street: street.display, number: '' });
        showScreen('result');
      });
      list.appendChild(btn);
    });
  }

  // ---------- wiring ----------
  $('#start-scan-btn').addEventListener('click', async () => {
    showScreen('home');
    $('#camera-view-wrap').classList.remove('hidden');
    $('#start-scan-btn').classList.add('hidden');
    await startCamera();
  });

  $('#capture-btn').addEventListener('click', () => {
    const c = captureFromVideo();
    handleImageReady(c);
  });

  $('#file-fallback-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const c = await captureFromFile(file);
    handleImageReady(c);
  });

  $('#scan-another-btn').addEventListener('click', () => {
    resetHome();
  });

  $('#manual-from-result-btn').addEventListener('click', () => {
    openManual('', '');
  });

  $('#manual-btn-home').addEventListener('click', () => {
    openManual('', '');
  });

  $('#manual-back-btn').addEventListener('click', () => {
    resetHome();
  });

  $('#manual-search-input').addEventListener('input', (e) => renderManualList(e.target.value));
  $('#manual-number-input').addEventListener('input', () => {
    // no-op; number is read at selection time
  });

  $('#toggle-raw-btn').addEventListener('click', () => {
    $('#result-raw-wrap').classList.toggle('hidden');
  });

  function resetHome() {
    stopCamera();
    $('#camera-view-wrap').classList.add('hidden');
    $('#start-scan-btn').classList.remove('hidden');
    $('#result-raw-wrap').classList.add('hidden');
    showScreen('home');
  }

  renderHistory();
  showScreen('home');
})();
