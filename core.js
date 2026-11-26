// dsh-google-sheets 核心：OAuth 桌面授权（PKCE + 本机回调）与 Google 表格 / Drive 接口。不依赖 DSH，便于单独测试。
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  // 只读 Drive（含文件名）：读知识库等 Google 文档用（John 2026-11-26：DSH 要直接读 Drive，不另做副本）
  'https://www.googleapis.com/auth/drive.readonly',
];
export const DOCS_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

// ── A1 地址小工具 ──
export function colToNum(col) { let n = 0; for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
export function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
// "'工作表 1'!B3:D9" → { sheet, col: 2, row: 3 }
export function rangeStart(range) {
  const s = String(range);
  const i = s.lastIndexOf('!');
  const sheet = i >= 0 ? s.slice(0, i) : '';
  const m = (i >= 0 ? s.slice(i + 1) : s).match(/^\$?([A-Za-z]+)\$?(\d+)/);
  return { sheet, col: m ? colToNum(m[1]) : 1, row: m ? Number(m[2]) : 1 };
}
export function cellName(start, r, c) { return `${numToCol(start.col + c)}${start.row + r}`; }
// "S!B3:D9" → { col: 4, row: 9 }；没写终点返回 null
export function rangeEnd(range) {
  const s = String(range); const i = s.lastIndexOf('!');
  const m = (i >= 0 ? s.slice(i + 1) : s).match(/:\$?([A-Za-z]+)\$?(\d+)$/);
  return m ? { col: colToNum(m[1]), row: Number(m[2]) } : null;
}
export function quoteSheet(name) { const n = String(name || '').replace(/^'|'$/g, '').replace(/'/g, "''"); return `'${n}'`; }
// 当成"普通值"的公式：=DATE(2026,11,25) 这类日期常量，可以被新日期覆盖
export const isValueFormula = (f) => /^=DATE\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i.test(String(f || '').trim());
export const norm = (v) => String(v ?? '').trim().toLowerCase();
// 写前检查：区域大小与数据一致、不覆盖公式、expect 的格子对得上。返回问题清单（空＝可以写）
export function preWriteProblems({ range, values, formulas, expectCells = {}, expectGot = {}, allowFormula = false }) {
  const out = [];
  const st = rangeStart(range), end = rangeEnd(range);
  const width = Math.max(...values.map(r => (r || []).length));
  if (end) {
    const rows = end.row - st.row + 1, cols = end.col - st.col + 1;
    if (rows !== values.length || cols !== width || values.some(r => (r || []).length !== cols))
      out.push({ problem: 'size', detail: `区域 ${rows} 行×${cols} 列，数据 ${values.length} 行×${width} 列，不一致。要写不连着的列就分开写，每次区域大小和数据完全一样。` });
  }
  if (!allowFormula) values.forEach((row, r) => (row || []).forEach((v, c) => {
    const cur = formulas?.[r]?.[c];
    if (typeof cur === 'string' && cur.startsWith('=') && !isValueFormula(cur) && String(v ?? '') !== cur)
      out.push({ problem: 'formula', cell: cellName(st, r, c), current: cur, detail: '这一格是公式，不能覆盖' });
  }));
  for (const [cell, want] of Object.entries(expectCells)) {
    const got = expectGot[cell.toUpperCase()];
    if (norm(got) !== norm(want)) out.push({ problem: 'expect', cell, want, got: got ?? '', detail: '这一格和预期不一样，可能找错行了' });
  }
  return out;
}

// 接受表格 ID 或完整网址
export function sheetId(x) {
  const s = String(x || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : s;
}

// 写入值和回读值是否算一致：原样相等、未格式化值相等、数字相等、公式比公式、空对空
export function sameCell(wrote, formatted, raw, formula) {
  const w = wrote === null || wrote === undefined ? '' : wrote;
  if (typeof w === 'string' && w.startsWith('=')) return String(formula ?? '') === w;
  const ws = String(w);
  if (ws === String(formatted ?? '')) return true;
  if (raw !== undefined && raw !== null && ws === String(raw)) return true;
  if (ws !== '' && !isNaN(Number(ws)) && raw !== undefined && raw !== '' && Number(ws) === Number(raw)) return true;
  if (ws.trim() === String(formatted ?? '').trim()) return true;
  return false;
}

export function compareGrid(values, fmt, raw, formula, start) {
  const bad = [];
  values.forEach((row, r) => (row || []).forEach((v, c) => {
    const f = fmt?.[r]?.[c], u = raw?.[r]?.[c], fo = formula?.[r]?.[c];
    if (!sameCell(v, f, u, fo)) bad.push({ cell: cellName(start, r, c), wrote: v, got: f ?? '' });
  }));
  return bad;
}

// ── 凭据与令牌文件 ──
export function dataDir(base) { const d = base || join(homedir(), '.dsh-gsheets'); mkdirSync(d, { recursive: true }); return d; }

export function findClientFile(dir, downloads = join(homedir(), 'Downloads')) {
  const own = join(dir, 'client.json');
  if (existsSync(own)) return own;
  if (!existsSync(downloads)) return '';
  const cands = readdirSync(downloads).filter(f => /^client_secret_.*\.json$/i.test(f))
    .map(f => ({ f, t: statSync(join(downloads, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!cands.length) return '';
  copyFileSync(join(downloads, cands[0].f), own);
  return own;
}

// Spreadsheets this plugin must never write (masters that only the company's robot may change). One ID per line,
// "#" starts a comment. Read from <dataDir>/readonly-ids.txt and <Downloads>/dsh-gsheets-readonly.txt on every write,
// so adding a line takes effect at once without a restart.
export function readonlyIds(dir, downloads = join(homedir(), 'Downloads')) {
  return readonlyList(dir, downloads).ids;
}
// A line "+<id>!<tab>" (optionally "+<id>!<tab>!<last column>", e.g. "+19s3…!DSH交办!C") opens ONE tab of a read-only
// spreadsheet for gsheets_append only — new rows at the bottom, never overwriting, nothing past the last column.
// JEPH (John 2026-11-26 16:47, A): DSH hands work to the Claude duty by appending a row on 「DSH交办」, while the rest of
// that workbook (群发outbox, 汇报登记) stays closed.
export function readonlyList(dir, downloads = join(homedir(), 'Downloads')) {
  const ids = new Set(), append = new Map();
  for (const f of [join(dir, 'readonly-ids.txt'), join(downloads, 'dsh-gsheets-readonly.txt')]) {
    try {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const t = line.replace(/#.*/, '').trim();
        const m = t.match(/^\+([\w-]{20,})!([^!]+?)(?:!([A-Za-z]{1,3}))?$/);
        if (m) { if (!append.has(m[1])) append.set(m[1], new Map()); append.get(m[1]).set(m[2].trim(), m[3] ? colToNum(m[3].toUpperCase()) : 0); continue; }
        if (/^[\w-]{20,}$/.test(t)) ids.add(t);
      }
    } catch {}
  }
  return { ids, append };
}

export function readClient(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const c = j.installed || j.web || j;
  if (!c.client_id) throw new Error('凭据文件里没有 client_id');
  return { id: c.client_id, secret: c.client_secret || '', authUri: c.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth', tokenUri: c.token_uri || 'https://oauth2.googleapis.com/token' };
}

export function openBrowser(url, { platform = process.platform, run = spawn } = {}) {
  try {
    if (platform === 'win32') run('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref?.();
    else run(platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref?.();
    return true;
  } catch { return false; }
}

// 授权：起一个只听 127.0.0.1 的临时服务收回调，换取 refresh_token
export async function authorize(client, { fetchImpl = fetch, open = openBrowser, timeoutMs = 300000, onUrl } = {}) {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  let server;
  const got = new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.searchParams.get('state') !== state) { res.writeHead(400); res.end('state mismatch'); return; }
      const code = u.searchParams.get('code'), err = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(code ? '<h2>授权成功，可以关掉这个页面，回到 DSH。</h2>' : `<h2>授权没有完成：${err || '未知原因'}</h2>`);
      code ? resolve(code) : reject(new Error('授权被取消：' + (err || '')));
    });
    server.listen(0, '127.0.0.1');
    setTimeout(() => reject(new Error('5 分钟内没有完成授权')), timeoutMs).unref?.();
  });
  await new Promise(r => server.once('listening', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = `${client.authUri}?` + new URLSearchParams({ client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' });
  onUrl?.(url);
  open(url);
  try {
    const code = await got;
    const r = await fetchImpl(client.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) throw new Error('换取令牌失败：' + (j.error_description || j.error || r.status));
    return { refresh_token: j.refresh_token, access_token: j.access_token, expiry: Date.now() + (j.expires_in || 3600) * 1000 - 60000, scope: j.scope };
  } finally { server.close(); }
}

export function tokenStore(dir) {
  const file = join(dir, 'token.json');
  return {
    file,
    load() { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } },
    save(t) { writeFileSync(file, JSON.stringify(t, null, 2), { mode: 0o600 }); },
  };
}

export async function accessToken(client, store, fetchImpl = fetch) {
  const t = store.load();
  if (!t?.refresh_token) throw new Error('NOT_AUTHORIZED');
  if (t.access_token && t.expiry > Date.now()) return t.access_token;
  const r = await fetchImpl(client.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) { if (j.error === 'invalid_grant') throw new Error('NOT_AUTHORIZED'); throw new Error('刷新令牌失败：' + (j.error_description || j.error || r.status)); }
  const nt = { ...t, access_token: j.access_token, expiry: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
  store.save(nt);
  return nt.access_token;
}

// ── 接口 ──
export function api(getToken, fetchImpl = fetch) {
  async function call(url, init = {}) {
    const tok = await getToken();
    const r = await fetchImpl(url, { ...init, headers: { authorization: 'Bearer ' + tok, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const text = await r.text();
    let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
    if (!r.ok) throw new Error(`Google ${r.status}：${j.error?.message || text.slice(0, 200)}`);
    return j;
  }
  const enc = encodeURIComponent;
  return {
    // 列出文件夹里的文件（只读）：folder 为空时按名字全盘找。返回 id、名字、类型、修改时间。
    async list(folder, query, max = 50) {
      const q = ['trashed=false'];
      if (folder) q.push(`'${folder}' in parents`);
      if (query) q.push(`name contains '${String(query).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      const j = await call(`${DRIVE}?` + new URLSearchParams({ q: q.join(' and '), pageSize: String(Math.min(max, 200)), orderBy: 'name', fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' }));
      return (j.files || []).map(f => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, url: f.webViewLink }));
    },
    // 在线读一份 Google 文档的最新版（导出成 Markdown，不落地）。不是 Google 文档的返回类型，不读内容。
    async readDoc(id) {
      const m = await call(`${DRIVE}/${id}?` + new URLSearchParams({ fields: 'id,name,mimeType,modifiedTime,webViewLink', supportsAllDrives: 'true' }));
      if (m.mimeType !== 'application/vnd.google-apps.document') return { id, title: m.name, type: m.mimeType, modified: m.modifiedTime, text: null, note: '不是 Google 文档，这个工具只读 Google 文档' };
      const tok = await getToken();
      for (const type of ['text/markdown', 'text/plain']) {
        const r = await fetchImpl(`${DRIVE}/${id}/export?mimeType=${encodeURIComponent(type)}`, { headers: { authorization: 'Bearer ' + tok } });
        if (r.ok) return { id, title: m.name, modified: m.modifiedTime, url: m.webViewLink, format: type, text: await r.text() };
        if (r.status !== 400) throw new Error(`Google ${r.status}：${(await r.text()).slice(0, 200)}`);
      }
      throw new Error('导出失败');
    },
    async find(query, max = 10) {
      const q = ["mimeType='application/vnd.google-apps.spreadsheet'", 'trashed=false'];
      if (query) q.push(`name contains '${String(query).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      const j = await call(`${DRIVE}?` + new URLSearchParams({ q: q.join(' and '), pageSize: String(Math.min(max, 50)), orderBy: 'modifiedTime desc', fields: 'files(id,name,modifiedTime,webViewLink,owners(emailAddress))', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' }));
      return (j.files || []).map(f => ({ id: f.id, name: f.name, modified: f.modifiedTime, url: f.webViewLink }));
    },
    async info(id) {
      const j = await call(`${SHEETS}/${id}?fields=properties.title,spreadsheetUrl,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`);
      return { title: j.properties?.title, url: j.spreadsheetUrl, sheets: (j.sheets || []).map(s => ({ title: s.properties.title, sheetId: s.properties.sheetId, rows: s.properties.gridProperties?.rowCount, cols: s.properties.gridProperties?.columnCount })) };
    },
    async get(id, range, render = 'FORMATTED_VALUE') {
      const j = await call(`${SHEETS}/${id}/values/${enc(range)}?valueRenderOption=${render}&dateTimeRenderOption=FORMATTED_STRING`);
      return { range: j.range, values: j.values || [] };
    },
    async batchGet(id, ranges, render = 'FORMATTED_VALUE') {
      if (!ranges.length) return [];
      const q = ranges.map(r => 'ranges=' + enc(r)).join('&');
      const j = await call(`${SHEETS}/${id}/values:batchGet?${q}&valueRenderOption=${render}&dateTimeRenderOption=FORMATTED_STRING`);
      return (j.valueRanges || []).map(v => v.values || []);
    },
    // 一次读回格子的显示值、实际值、公式（写后核对用，省读取次数）
    async grid(id, range) {
      const fields = 'sheets(data(rowData(values(formattedValue,userEnteredValue,effectiveValue))))';
      const j = await call(`${SHEETS}/${id}?ranges=${enc(range)}&includeGridData=true&fields=${enc(fields)}`);
      const rows = j.sheets?.[0]?.data?.[0]?.rowData || [];
      const pick = (o) => o ? (o.formulaValue ?? o.stringValue ?? o.numberValue ?? o.boolValue ?? '') : '';
      const fmt = [], raw = [], formula = [];
      rows.forEach(r => { const v = r.values || []; fmt.push(v.map(c => c.formattedValue ?? '')); raw.push(v.map(c => pick(c.effectiveValue))); formula.push(v.map(c => pick(c.userEnteredValue))); });
      return { fmt, raw, formula };
    },
    async details(id, range) {
      const fields = 'sheets(properties.title,data(startRow,startColumn,rowData(values(formattedValue,note,effectiveFormat(textFormat(foregroundColorStyle,bold,strikethrough),backgroundColorStyle)))))';
      return call(`${SHEETS}/${id}?ranges=${enc(range)}&includeGridData=true&fields=${enc(fields)}`);
    },
    async update(id, range, values, mode = 'USER_ENTERED') {
      return call(`${SHEETS}/${id}/values/${enc(range)}?valueInputOption=${mode}`, { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) });
    },
    async append(id, range, values, mode = 'USER_ENTERED') {
      return call(`${SHEETS}/${id}/values/${enc(range)}:append?valueInputOption=${mode}&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values }) });
    },
    async create(title, sheetTitle) {
      return call(SHEETS, { method: 'POST', body: JSON.stringify({ properties: { title }, ...(sheetTitle ? { sheets: [{ properties: { title: sheetTitle } }] } : {}) }) });
    },
  };
}

// 颜色：只报非黑色的字和非白色的底
export function colorHex(style) {
  const c = style?.rgbColor; if (!c) return '';
  const h = v => Math.round((v || 0) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.red) + h(c.green) + h(c.blue);
}
export function flattenDetails(j, maxCells = 5000) {
  const out = []; let n = 0;
  for (const s of j.sheets || []) for (const d of s.data || []) {
    const r0 = (d.startRow || 0) + 1, c0 = (d.startColumn || 0) + 1;
    (d.rowData || []).forEach((row, r) => (row.values || []).forEach((v, c) => {
      if (n >= maxCells) return;
      const fg = colorHex(v.effectiveFormat?.textFormat?.foregroundColorStyle);
      const bg = colorHex(v.effectiveFormat?.backgroundColorStyle);
      const cell = { cell: `${numToCol(c0 + c)}${r0 + r}` };
      if (v.formattedValue !== undefined) cell.value = v.formattedValue;
      if (v.note) cell.note = v.note;
      if (fg && fg !== '#000000') cell.color = fg;
      if (bg && bg !== '#ffffff') cell.background = bg;
      if (v.effectiveFormat?.textFormat?.strikethrough) cell.strike = true;
      if (cell.note || cell.color || cell.background || cell.strike) { out.push(cell); n++; }
    }));
  }
  return { cells: out, truncated: n >= maxCells };
}
