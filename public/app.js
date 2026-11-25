// OST マーケットプレイスボード — 画面ロジック
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  board: null,
  shot: null,          // { dataUrl } 撮影直後の写真（未保存）
  pick: { slot: null, room: null },
  stream: null,
  mirrored: false,
  recent: [],
};

const isStage = new URLSearchParams(location.search).get('view') === 'stage';

/* ============ 通信 ============ */

async function loadBoard() {
  const res = await fetch('/api/board', { cache: 'no-store' });
  state.board = await res.json();
}

// 変更は必ずこの関数を通す。別ウィンドウが先に保存していたら取り込んで貼り直す。
async function mutate(fn) {
  setSaveState('保存中…');
  for (let attempt = 0; attempt < 4; attempt++) {
    const draft = structuredClone(state.board);
    fn(draft);
    const res = await fetch('/api/board', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (res.ok) {
      state.board = await res.json();
      renderAll();
      setSaveState('保存済み');
      return true;
    }
    if (res.status === 409) {
      state.board = (await res.json()).board;
      continue; // 最新を土台にもう一度
    }
    setSaveState('保存できません');
    toast('保存に失敗しました');
    return false;
  }
  setSaveState('保存できません');
  toast('他の画面と競合しました。開き直してください');
  return false;
}

// 他の画面（投影など）の変更を拾う。SSEだと接続を張り続けてタブの枚数だけ
// ブラウザの同時接続数を食い、OCRなど他の通信が止まるのでポーリングにしている。
function subscribe() {
  setInterval(async () => {
    if (!state.board) return;
    try {
      const res = await fetch('/api/rev', { cache: 'no-store' });
      const { rev } = await res.json();
      if (rev !== state.board.rev) {
        await loadBoard();
        renderAll();
      }
    } catch {
      // 一時的に繋がらなくても次の周回で拾う
    }
  }, 1500);
}

/* ============ 表示のこまごま ============ */

let saveTimer;
function setSaveState(text) {
  const el = $('#saveState');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-saving', text === '保存中…');
  clearTimeout(saveTimer);
  if (text === '保存済み') saveTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ============ カメラ ============ */

async function startCamera(deviceId) {
  stopCamera();
  const constraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1440 } }
      : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false,
  };
  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // facingMode を持たない内蔵カメラ向けのフォールバック
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (err2) {
      $('#camGuide').innerHTML = `<p>カメラを使えませんでした</p><p class="sub">${String(err2.message || err2)}<br>「ファイルから」でも登録できます</p>`;
      $('#camGuide').hidden = false;
      return;
    }
  }
  const video = $('#video');
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  $('#camGuide').hidden = true;
  await fillCameraList();
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

async function fillCameraList() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const sel = $('#cameraSelect');
  const current = state.stream?.getVideoTracks()[0]?.getSettings()?.deviceId;
  sel.innerHTML = '';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || `カメラ ${i + 1}`;
    if (c.deviceId === current) o.selected = true;
    sel.append(o);
  });
  if (cams.length <= 1) sel.style.display = 'none';
}

// 長辺 1600px の JPEG に落としてから保存する（枚数が増えても投影が重くならない）
function toJpegDataUrl(source, sw, sh, max = 1600) {
  const scale = Math.min(1, max / Math.max(sw, sh));
  const canvas = $('#canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

function capture() {
  const video = $('#video');
  if (!video.videoWidth) { toast('カメラの準備がまだです'); return; }
  const w = video.videoWidth, h = video.videoHeight;
  showShot(toJpegDataUrl(video, w, h), toJpegDataUrl(video, w, h, 1024));
}

function showShot(dataUrl, ocrUrl) {
  state.shot = dataUrl;
  const img = $('#shot');
  img.src = dataUrl;
  setShootMode(true);
  $('#entryHint').textContent = '置き場所を選んで「ボードに追加」。選ばなければ未配置に入ります。';
  $('#inTitle').focus();
  requestOcr(ocrUrl || dataUrl);
}

// 撮影前＝カメラと撮影ボタン、撮影後＝写真と「撮り直す／追加」だけを出す
function setShootMode(confirming) {
  $('#shot').hidden = !confirming;
  $('#video').hidden = confirming;
  $('#shotBadge').hidden = !confirming;
  $('#stageWrap').classList.toggle('is-confirming', confirming);
  $('#btnShoot').hidden = confirming;
  $('#btnMirror').hidden = confirming;
  $('#btnFile').hidden = confirming;
  $('#btnRetake').hidden = !confirming;
  $('#btnRegisterHere').hidden = !confirming;
  $('#btnRegister').disabled = !confirming;
  $('#camHint').textContent = confirming
    ? '読めなければ「撮り直す」。テーマ名と置き場所は右側で入れられます（任意）。'
    : 'スケッチブックを机に置いて、iPhoneの連係カメラで上から撮るのが一番きれいに入ります。';
}

/* ---- ローカル文字起こし（glm-ocr）。撮影と同時に走り、待たせない ---- */
let ocrGen = 0;
function setOcrNote(text, cls = '') {
  const el = $('#ocrNote');
  el.textContent = text;
  el.className = 'hint ocr-note' + (cls ? ' ' + cls : '');
}

async function requestOcr(dataUrl) {
  const gen = ++ocrGen;
  if (state.board?.ocr === false) { setOcrNote(''); return; }
  setOcrNote('読み取り中…', 'is-working');
  try {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    });
    const { text, ms, error } = await res.json();
    if (gen !== ocrGen) return; // 撮り直し済みなら捨てる
    if (error) { setOcrNote('読み取れませんでした。手で入力できます', 'is-failed'); return; }
    const line = tidyOcr(text);
    if (!line) { setOcrNote('文字を読み取れませんでした', 'is-failed'); return; }
    const input = $('#inTitle');
    if (!input.value.trim()) input.value = line;
    setOcrNote(`読み取りました（${(ms / 1000).toFixed(1)}秒）— 違っていたら直してください`);
  } catch {
    if (gen === ocrGen) setOcrNote('読み取れませんでした。手で入力できます', 'is-failed');
  }
}

// モデルはコードフェンスや同じ行の繰り返しを混ぜてくるので、落としてから1行にまとめる。
function tidyOcr(text) {
  const lines = String(text || '')
    .replace(/```[\s\S]*$/, '') // 最初のコードフェンス以降は繰り返しのゴミ
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const uniq = lines.filter((l) => (seen.has(l) ? false : seen.add(l)));
  const line = uniq.join(' ').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}

function retake() {
  state.shot = null;
  ocrGen++; // 走っている読み取りの結果を捨てる
  setOcrNote('');
  setShootMode(false);
  $('#entryHint').textContent = 'まず撮影してください。';
}

async function loadFile(file) {
  const bitmap = await createImageBitmap(file);
  showShot(toJpegDataUrl(bitmap, bitmap.width, bitmap.height),
           toJpegDataUrl(bitmap, bitmap.width, bitmap.height, 1024));
  bitmap.close?.();
}

/* ============ 登録 ============ */

async function registerCard() {
  if (!state.shot) return;
  $('#btnRegister').disabled = true;
  $('#btnRegisterHere').disabled = true;
  const res = await fetch('/api/photo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: state.shot }),
  });
  if (!res.ok) { toast('写真の保存に失敗しました'); $('#btnRegister').disabled = false; $('#btnRegisterHere').disabled = false; return; }
  const { photo } = await res.json();

  const card = {
    id: uid('c'),
    photo,
    title: $('#inTitle').value.trim(),
    host: $('#inHost').value.trim(),
    slot: state.pick.slot,
    room: state.pick.room,
    createdAt: new Date().toISOString(),
  };
  const ok = await mutate((b) => { b.cards.push(card); });
  if (!ok) { $('#btnRegister').disabled = false; $('#btnRegisterHere').disabled = false; return; }

  state.recent.unshift(card);
  state.recent = state.recent.slice(0, 8);
  toast(placeLabel(card) ? `${placeLabel(card)} に追加しました` : '未配置に追加しました');

  $('#btnRegisterHere').disabled = false;
  retake();
  $('#inTitle').value = '';
  $('#inHost').value = '';
  state.pick = { slot: null, room: null };
  renderPickers();
  renderRecent();
}

function placeLabel(card) {
  if (!card.slot || !card.room) return '';
  const s = state.board.slots.find((x) => x.id === card.slot);
  const r = state.board.rooms.find((x) => x.id === card.room);
  if (!s || !r) return '';
  return `${s.label} / ${r.label}`;
}

/* ============ 描画 ============ */

function renderAll() {
  if (!state.board) return;
  const b = state.board;
  $('#brandTitle') && ($('#brandTitle').textContent = b.title);
  document.title = b.title;

  if (isStage) {
    $('#stageTitle').textContent = b.title;
    $('#stageSubtitle').textContent = b.subtitle || '';
    renderBoard($('#stageBoard'), true);
    return;
  }

  $('#boardTitle').textContent = b.title;
  $('#boardSubtitle').textContent = b.subtitle || '';
  $('#showPhotos').checked = b.showPhotos !== false;
  renderPickers();
  renderBoard($('#board'), false);
  renderPool();
  renderRecent();
  renderConfig();
}

function cardEl(card, readonly) {
  const el = document.createElement(readonly ? 'div' : 'button');
  el.className = 'card';
  if (!readonly) {
    el.type = 'button';
    el.draggable = true;
    el.dataset.cardId = card.id;
    el.addEventListener('click', () => openCardDialog(card.id));
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
  }
  if (card.photo) {
    const img = document.createElement('img');
    img.src = `/photos/${card.photo}`;
    img.alt = card.title || 'テーマの写真';
    img.loading = 'lazy';
    el.append(img);
  }
  if (card.title) {
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = card.title;
    el.append(t);
  }
  if (card.host) {
    const h = document.createElement('span');
    h.className = 'h';
    h.textContent = card.host;
    el.append(h);
  }
  return el;
}

function renderBoard(root, readonly) {
  const b = state.board;
  root.innerHTML = '';
  root.style.gridTemplateColumns = `132px repeat(${b.rooms.length}, minmax(140px, 1fr))`;
  root.classList.toggle('no-photo', state.board.showPhotos === false);

  const corner = document.createElement('div');
  corner.className = 'corner-cell';
  root.append(corner);

  for (const room of b.rooms) {
    const h = document.createElement('div');
    h.className = 'head-cell';
    h.textContent = room.label;
    root.append(h);
  }

  for (const slot of b.slots) {
    const t = document.createElement('div');
    t.className = 'time-cell';
    t.textContent = slot.label;
    root.append(t);

    for (const room of b.rooms) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.slot = slot.id;
      cell.dataset.room = room.id;
      const cards = b.cards.filter((c) => c.slot === slot.id && c.room === room.id);
      if (!cards.length) cell.classList.add('is-empty');
      cards.forEach((c) => cell.append(cardEl(c, readonly)));
      if (!readonly) attachDropTarget(cell, () => ({ slot: slot.id, room: room.id }));
      root.append(cell);
    }
  }
}

function attachDropTarget(el, getTarget) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('is-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('is-over');
    const id = e.dataTransfer.getData('text/plain');
    const { slot, room } = getTarget();
    await mutate((b) => {
      const c = b.cards.find((x) => x.id === id);
      if (c) { c.slot = slot; c.room = room; }
    });
  });
}

function renderPool() {
  const pool = $('#pool');
  pool.innerHTML = '';
  pool.classList.toggle('no-photo', state.board.showPhotos === false);
  const cards = state.board.cards.filter((c) => !c.slot || !c.room);
  $('#poolCount').textContent = String(cards.length);
  cards.forEach((c) => pool.append(cardEl(c, false)));
  if (!pool.dataset.dropBound) {
    attachDropTarget(pool, () => ({ slot: null, room: null }));
    pool.dataset.dropBound = '1';
  }
}

function renderRecent() {
  const strip = $('#recentStrip');
  strip.innerHTML = '';
  for (const card of state.recent) {
    const live = state.board.cards.find((c) => c.id === card.id) || card;
    const item = document.createElement('div');
    item.className = 'recent-item';
    const img = document.createElement('img');
    img.src = `/photos/${live.photo}`;
    img.alt = '';
    const p = document.createElement('p');
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = placeLabel(live) || '未配置';
    p.append(where);
    if (live.title) {
      p.append(document.createElement('br'));
      p.append(document.createTextNode(live.title));
    }
    item.append(img, p);
    strip.append(item);
  }
}

// 時間・ルームのチップ。既に埋まっているマスは薄くして、重なりに気づけるようにする。
function pickerChips(container, items, selectedId, onPick, opts = {}) {
  container.innerHTML = '';
  if (opts.allowNone) {
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'chip' + (selectedId ? '' : ' is-on');
    none.textContent = '未配置';
    none.addEventListener('click', () => onPick(null));
    container.append(none);
  }
  for (const item of items) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (item.id === selectedId ? ' is-on' : '');
    chip.textContent = item.label;
    if (opts.takenIds?.has(item.id)) chip.classList.add('is-taken');
    chip.addEventListener('click', () => onPick(item.id === selectedId && !opts.allowNone ? null : item.id));
    container.append(chip);
  }
}

function takenRoomIds(slotId, exceptCardId) {
  const s = new Set();
  if (!slotId) return s;
  for (const c of state.board.cards) {
    if (c.slot === slotId && c.room && c.id !== exceptCardId) s.add(c.room);
  }
  return s;
}

function renderPickers() {
  pickerChips($('#slotPick'), state.board.slots, state.pick.slot, (id) => { state.pick.slot = id; renderPickers(); });
  pickerChips($('#roomPick'), state.board.rooms, state.pick.room, (id) => { state.pick.room = id; renderPickers(); },
    { takenIds: takenRoomIds(state.pick.slot) });
}

/* ============ カード編集 ============ */

let dialogCardId = null;
function openCardDialog(id) {
  const card = state.board.cards.find((c) => c.id === id);
  if (!card) return;
  dialogCardId = id;
  const draft = { slot: card.slot, room: card.room };

  const photo = $('#dlgPhoto');
  photo.hidden = !card.photo;
  if (card.photo) photo.src = `/photos/${card.photo}`;
  $('#dlgTitle').value = card.title || '';
  $('#dlgHost').value = card.host || '';

  const paint = () => {
    pickerChips($('#dlgSlotPick'), state.board.slots, draft.slot, (v) => { draft.slot = v; paint(); }, { allowNone: true });
    pickerChips($('#dlgRoomPick'), state.board.rooms, draft.room, (v) => { draft.room = v; paint(); },
      { allowNone: true, takenIds: takenRoomIds(draft.slot, id) });
  };
  paint();

  const dlg = $('#cardDialog');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') {
      await mutate((b) => {
        const c = b.cards.find((x) => x.id === dialogCardId);
        if (!c) return;
        c.title = $('#dlgTitle').value.trim();
        c.host = $('#dlgHost').value.trim();
        c.slot = draft.slot;
        c.room = draft.room;
      });
    } else if (dlg.returnValue === 'delete') {
      if (confirm('このカードを消します。よろしいですか？')) {
        await mutate((b) => { b.cards = b.cards.filter((x) => x.id !== dialogCardId); });
      }
    }
  }, { once: true });
}

/* ============ 設定 ============ */

function cfgRow(item, kind) {
  const row = document.createElement('div');
  row.className = 'cfg-row';

  const label = document.createElement('input');
  label.className = 'input';
  label.value = item.label;
  label.addEventListener('change', () => {
    mutate((b) => {
      const target = (kind === 'slot' ? b.slots : b.rooms).find((x) => x.id === item.id);
      if (target) target.label = label.value;
    });
  });
  row.append(label);

  const del = document.createElement('button');
  del.className = 'cfg-del';
  del.type = 'button';
  del.textContent = '×';
  del.title = '削除';
  del.addEventListener('click', () => {
    const used = state.board.cards.some((c) => (kind === 'slot' ? c.slot : c.room) === item.id);
    if (used && !confirm('ここに入っているカードは未配置に戻ります。削除しますか？')) return;
    mutate((b) => {
      if (kind === 'slot') {
        b.slots = b.slots.filter((x) => x.id !== item.id);
        b.cards.forEach((c) => { if (c.slot === item.id) c.slot = null; });
      } else {
        b.rooms = b.rooms.filter((x) => x.id !== item.id);
        b.cards.forEach((c) => { if (c.room === item.id) c.room = null; });
      }
    });
  });
  row.append(del);
  return row;
}

function renderConfig() {
  const b = state.board;
  // テキスト入力中だけ差し替えを控える（ボタン操作のあとはちゃんと描き直す）
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && ae.closest('#view-config')) return;
  $('#cfgOcr').checked = b.ocr !== false;
  $('#cfgTitle').value = b.title;
  $('#cfgSubtitle').value = b.subtitle || '';
  $('#cfgSlots').innerHTML = '';
  b.slots.forEach((s) => $('#cfgSlots').append(cfgRow(s, 'slot')));
  $('#cfgRooms').innerHTML = '';
  b.rooms.forEach((r) => $('#cfgRooms').append(cfgRow(r, 'room')));
}

function setRoomCount(n) {
  mutate((b) => {
    while (b.rooms.length > n) {
      const gone = b.rooms.pop();
      b.cards.forEach((c) => { if (c.room === gone.id) c.room = null; });
    }
    while (b.rooms.length < n) {
      b.rooms.push({ id: uid('r'), label: `ルーム${b.rooms.length + 1}` });
    }
  });
}

/* ============ 起動 ============ */

function bindUI() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${tab.dataset.view}`));
      if (tab.dataset.view === 'shoot') { if (!state.stream) startCamera(); }
      else stopCamera();
    });
  });

  $('#btnShoot').addEventListener('click', capture);
  $('#btnRetake').addEventListener('click', retake);
  $('#btnRegister').addEventListener('click', registerCard);
  $('#btnRegisterHere').addEventListener('click', registerCard);
  $('#cameraSelect').addEventListener('change', (e) => startCamera(e.target.value));
  $('#btnMirror').addEventListener('click', () => {
    state.mirrored = !state.mirrored;
    $('#video').classList.toggle('is-mirrored', state.mirrored);
  });
  for (const id of ['#inTitle', '#inHost']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.shot) { e.preventDefault(); registerCard(); }
    });
  }
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
    e.target.value = '';
  });

  $('#showPhotos').addEventListener('change', (e) => mutate((b) => { b.showPhotos = e.target.checked; }));
  $('#btnPrint').addEventListener('click', () => window.print());

  $('#cfgOcr').addEventListener('change', (e) => mutate((b) => { b.ocr = e.target.checked; }));
  $('#cfgTitle').addEventListener('change', (e) => mutate((b) => { b.title = e.target.value; }));
  $('#cfgSubtitle').addEventListener('change', (e) => mutate((b) => { b.subtitle = e.target.value; }));
  $('#btnAddSlot').addEventListener('click', () => mutate((b) => { b.slots.push({ id: uid('s'), label: '00:00〜00:00' }); }));
  $('#btnAddRoom').addEventListener('click', () => mutate((b) => { b.rooms.push({ id: uid('r'), label: `ルーム${b.rooms.length + 1}` }); }));
  $$('[data-rooms]').forEach((btn) => btn.addEventListener('click', () => setRoomCount(Number(btn.dataset.rooms))));

  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.board, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ost-board-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#btnClearCards').addEventListener('click', () => {
    if (!confirm('カードを全部消します。写真ファイルは data/photos に残ります。よろしいですか？')) return;
    mutate((b) => { b.cards = []; });
    state.recent = [];
  });

  // スペースキーで撮影（撮る画面かつ入力欄以外）
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (!$('#view-shoot').classList.contains('is-active')) return;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(document.activeElement?.tagName || '')) return;
    e.preventDefault();
    state.shot ? null : capture();
  });
}

async function main() {
  await loadBoard();
  if (isStage) {
    document.body.classList.add('stage-mode');
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-stage'));
  } else {
    bindUI();
    startCamera();
  }
  renderAll();
  subscribe();
}

main();
