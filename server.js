// OST マーケットプレイスボード — ローカルサーバ（外部依存なし / Node 18+）
// 起動: node server.js  →  http://localhost:5173
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const PORT = Number(process.env.PORT || 5173);

await fsp.mkdir(PHOTO_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function defaultBoard() {
  return {
    rev: 1,
    title: 'OST マーケットプレイス',
    subtitle: '出たテーマ（＝セッション）×「テーブル」のマスに貼っていきます',
    showPhotos: true,
    slots: [
      { id: 's1', label: '1コマ目' },
      { id: 's2', label: '2コマ目' },
      { id: 's3', label: '3コマ目' },
    ],
    rooms: [
      { id: 'r1', label: 'テーブル1' },
      { id: 'r2', label: 'テーブル2' },
      { id: 'r3', label: 'テーブル3' },
      { id: 'r4', label: 'テーブル4' },
      { id: 'r5', label: 'テーブル5' },
      { id: 'r6', label: 'テーブル6' },
      { id: 'r7', label: 'テーブル7' },
      { id: 'r8', label: 'テーブル8' },
    ],
    cards: [],
  };
}

async function readBoard() {
  try {
    const raw = await fsp.readFile(BOARD_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    const b = defaultBoard();
    await writeBoard(b);
    return b;
  }
}

// 書き込みは一時ファイル経由。落ちても board.json が半端な状態にならない。
let writeChain = Promise.resolve();
function writeBoard(board) {
  writeChain = writeChain.then(async () => {
    const tmp = BOARD_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(board, null, 2), 'utf8');
    await fsp.rename(tmp, BOARD_FILE);
  });
  return writeChain;
}

// 直近の保存を日付つきで退避。誤操作からの巻き戻し用。
async function snapshot(board) {
  const dir = path.join(DATA_DIR, 'history');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(dir, `board-${stamp}.json`), JSON.stringify(board, null, 2), 'utf8');
  const files = (await fsp.readdir(dir)).filter((f) => f.startsWith('board-')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 40))) {
    await fsp.rm(path.join(dir, f), { force: true });
  }
}

// --- ローカルOCR（Ollama / glm-ocr）--------------------------------
// ワークショップ中はモデルを常駐させ、1枚あたり数秒で返す。落ちても運用は止めない。
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const OCR_MODEL = process.env.OCR_MODEL || 'glm-ocr';
const KEEP_ALIVE = '6h';
// 短い指示文でないとモデルが読み取り結果に指示そのものを混ぜてくる。
// それでも混ざることがあるので、下の stripPrompt で必ず落とす。
const OCR_PROMPT = '文字を書き出してください。';

function stripPrompt(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== OCR_PROMPT);
  return lines.join('\n').split(OCR_PROMPT).join('').trim();
}

async function ocr(base64Jpeg, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OCR_MODEL,
        prompt: OCR_PROMPT,
        images: [base64Jpeg],
        stream: false,
        keep_alive: KEEP_ALIVE,
        // 生成量を絞るのが最大の高速化。OSTのテーマは1〜2行なのでこれで足りる。
        // 上限が無いとモデルが同じ行を延々と出し続けて数十秒かかる。
        options: { temperature: 0, num_predict: 96, repeat_penalty: 1.1 },
      }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const data = await r.json();
    return stripPrompt((data.response || '').trim());
  } finally {
    clearTimeout(timer);
  }
}

// 起動時にモデルを載せ、画像処理まで通しておく。
// これをやらないと本番の1枚目だけ10〜30秒かかる（モデルロード＋画像パスの初期化）。
async function warmUpOcr() {
  const t = Date.now();
  try {
    await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OCR_MODEL, prompt: '.', stream: false, keep_alive: KEEP_ALIVE }),
      signal: AbortSignal.timeout(180000),
    }).then((r) => r.json());

    const jpeg = await fsp.readFile(path.join(ROOT, 'assets', 'warmup.jpg'));
    const text = await ocr(jpeg.toString('base64'), 180000);
    console.log(`  OCR 準備完了（${OCR_MODEL} / ${((Date.now() - t) / 1000).toFixed(1)}秒 / 試し読み「${text.split('\n')[0].slice(0, 12)}」）`);
  } catch (err) {
    console.log(`  OCR は使えません（${String(err.message || err)}）— 手入力で運用できます`);
    console.log('  Ollama を起動していますか？  ollama serve');
  }
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function readBody(req, limitBytes = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 各画面は /api/rev を短い間隔で見に来る。
// SSEは接続を張りっぱなしにするため、タブを何枚も開くとブラウザの同時接続数
// （HTTP/1.1 でオリジンあたり6本）を食い潰し、他の通信がまるごと止まる。

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/rev' && req.method === 'GET') {
      const b = await readBoard();
      return json(res, 200, { rev: b.rev });
    }

    if (p === '/api/board' && req.method === 'GET') {
      return json(res, 200, await readBoard());
    }

    if (p === '/api/board' && req.method === 'PUT') {
      const incoming = JSON.parse(await readBody(req));
      const current = await readBoard();
      // 楽観ロック。別ウィンドウが先に保存していたら弾いて、呼び出し側に再取得させる。
      if (typeof incoming.rev === 'number' && incoming.rev !== current.rev) {
        return json(res, 409, { error: 'conflict', board: current });
      }
      await snapshot(current);
      const next = { ...incoming, rev: current.rev + 1 };
      await writeBoard(next);
      return json(res, 200, next);
    }

    if (p === '/api/photo' && req.method === 'POST') {
      const { dataUrl } = JSON.parse(await readBody(req));
      const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/s.exec(dataUrl || '');
      if (!m) return json(res, 400, { error: 'dataUrl が不正です' });
      const ext = m[1] === 'png' ? 'png' : 'jpg';
      const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      await fsp.writeFile(path.join(PHOTO_DIR, name), Buffer.from(m[2], 'base64'));
      return json(res, 200, { photo: name, url: `/photos/${name}` });
    }

    if (p === '/api/ocr' && req.method === 'POST') {
      const { dataUrl } = JSON.parse(await readBody(req));
      const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/s.exec(dataUrl || '');
      if (!m) return json(res, 400, { error: 'dataUrl が不正です' });
      const t = Date.now();
      try {
        const text = await ocr(m[2]);
        return json(res, 200, { text, ms: Date.now() - t });
      } catch (err) {
        return json(res, 200, { text: '', error: String(err.message || err), ms: Date.now() - t });
      }
    }

    if (p.startsWith('/photos/')) {
      const name = path.basename(decodeURIComponent(p));
      const file = path.join(PHOTO_DIR, name);
      try {
        const buf = await fsp.readFile(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'image/jpeg', 'cache-control': 'max-age=31536000' });
        return res.end(buf);
      } catch {
        res.writeHead(404); return res.end();
      }
    }

    return serveStatic(res, p);
  } catch (err) {
    return json(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('\n  OST マーケットプレイスボード');
  console.log(`  操作用   http://localhost:${PORT}/`);
  console.log(`  投影用   http://localhost:${PORT}/?view=stage`);
  for (const n of nets) console.log(`  同一LAN  http://${n.address}:${PORT}/   （閲覧のみ。カメラはlocalhostだけ）`);
  console.log('\n  終了は Ctrl+C。データは data/board.json と data/photos/ に入ります。');
  warmUpOcr();
});
