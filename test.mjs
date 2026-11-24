// 本地测试：模拟 Google 授权和表格接口，不连真实服务
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from './core.js';

let pass = 0; const ok = (n) => { pass++; console.log('ok', n); };

// 1. 地址小工具
assert.equal(core.colToNum('A'), 1); assert.equal(core.colToNum('AA'), 27); assert.equal(core.numToCol(28), 'AB');
assert.deepEqual(core.rangeStart("'工作表 1'!B3:D9"), { sheet: "'工作表 1'", col: 2, row: 3 });
assert.deepEqual(core.rangeStart('A1'), { sheet: '', col: 1, row: 1 });
assert.equal(core.sheetId('https://docs.google.com/spreadsheets/d/1UFTaSY8iZqsPUOkn_u2b8KCvPGPTgo5E_X-h1sbsJwo/edit#gid=0'), '1UFTaSY8iZqsPUOkn_u2b8KCvPGPTgo5E_X-h1sbsJwo');
ok('A1 地址和表格网址解析');

// 2. 比对规则
assert.ok(core.sameCell('DSH 测试', 'DSH 测试', 'DSH 测试'));
assert.ok(core.sameCell(1, '1', 1));
assert.ok(core.sameCell('2700', '2,700', 2700));
assert.ok(core.sameCell('=A1*2', '4', 4, '=A1*2'));
assert.ok(!core.sameCell('=A1*2', '4', 4, '=A1*3'));
assert.ok(!core.sameCell('B1', 'DSH 测试', 'DSH 测试'));
assert.ok(core.sameCell('', undefined, undefined));
const bad = core.compareGrid([['a', 'b'], ['c', 'd']], [['a', 'x'], ['c']], [['a', 'x'], ['c']], [], core.rangeStart('S!B2'));
assert.deepEqual(bad.map(b => b.cell), ['C2', 'C3']);
ok('写入回读比对（包括刚才那种 A1 写成 "B1" 的错误能抓出来）');

// 3. 凭据文件：从下载文件夹找最新的 client_secret_*.json
const dir = mkdtempSync(join(tmpdir(), 'gs-')), dl = mkdtempSync(join(tmpdir(), 'dl-'));
assert.equal(core.findClientFile(dir, dl), '');
writeFileSync(join(dl, 'client_secret_123.apps.googleusercontent.com.json'), JSON.stringify({ installed: { client_id: 'CID', client_secret: 'CS', auth_uri: 'https://auth', token_uri: 'https://token' } }));
const cf = core.findClientFile(dir, dl);
assert.ok(cf.endsWith('client.json') && existsSync(cf));
assert.deepEqual(core.readClient(cf), { id: 'CID', secret: 'CS', authUri: 'https://auth', tokenUri: 'https://token' });
ok('找到并复制授权凭据');

// 4. 授权流程：模拟浏览器打开授权页后跳回本机
const client = core.readClient(cf);
let tokenReq;
const fakeFetch = async (url, init) => {
  if (url === 'https://token') {
    tokenReq = Object.fromEntries(new URLSearchParams(String(init.body)));
    if (tokenReq.grant_type === 'authorization_code') return { ok: true, json: async () => ({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 }) };
    return { ok: true, json: async () => ({ access_token: 'AT2', expires_in: 3600 }) };
  }
  throw new Error('unexpected ' + url);
};
const t = await core.authorize(client, { fetchImpl: fakeFetch, open: (u) => {
  const p = new URL(u);
  assert.equal(p.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(p.searchParams.get('scope').includes('spreadsheets'));
  setTimeout(() => fetch(`${p.searchParams.get('redirect_uri')}/?code=CODE1&state=${p.searchParams.get('state')}`), 20);
} });
assert.equal(t.refresh_token, 'RT1'); assert.equal(tokenReq.code, 'CODE1'); assert.ok(tokenReq.code_verifier.length > 40);
const store = core.tokenStore(dir); store.save({ ...t, expiry: 0 });
assert.equal(await core.accessToken(client, store, fakeFetch), 'AT2');
assert.equal(store.load().refresh_token, 'RT1');
ok('授权（PKCE、本机回调）和令牌自动续期');

// 5. 插件整体：模拟表格接口
const sheet = {}; // "A1" → value
const setRange = (start, values) => values.forEach((row, r) => row.forEach((v, c) => { sheet[core.cellName(start, r, c)] = v; }));
const getRange = (range, render) => {
  const ref = range.split('!').pop();
  const wc = ref.match(/^([A-Z]+):([A-Z]+)$/);
  if (wc) { // 整列：读到最后一个有内容的行为止（和 Google 一样去掉末尾空行）
    const c1 = core.colToNum(wc[1]), c2 = core.colToNum(wc[2]); let last = 0;
    for (const k of Object.keys(sheet)) { const mm = k.match(/^([A-Z]+)(\d+)$/); const c = core.colToNum(mm[1]); if (c >= c1 && c <= c2 && sheet[k] !== '' && sheet[k] !== undefined) last = Math.max(last, +mm[2]); }
    return last ? getRange(`${wc[1]}1:${wc[2]}${last}`, render) : [];
  }
  const m = ref.match(/([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?/);
  const c1 = core.colToNum(m[1]), r1 = +m[2], c2 = m[3] ? core.colToNum(m[3]) : c1, r2 = m[4] ? +m[4] : r1;
  const out = [];
  for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) { const v = sheet[core.numToCol(c) + r]; row.push(v === undefined ? '' : (render === 'FORMATTED_VALUE' && typeof v === 'number' ? v.toLocaleString('en-US') : v)); } out.push(row); }
  return out;
};
let corrupt = false;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const j = (x, s = 200) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(x), json: async () => x });
  if (url === 'https://token') return fakeFetch(url, init);
  assert.equal(init.headers.authorization, 'Bearer AT2');
  if (u.pathname.endsWith(':append')) {
    const body = JSON.parse(init.body); const range = decodeURIComponent(u.pathname.split('/values/')[1].replace(':append', ''));
    let r = 1; while (sheet['A' + r] !== undefined) r++;
    setRange({ col: 1, row: r }, body.values);
    return j({ updates: { updatedRange: `${range.split('!')[0]}!A${r}:${core.numToCol(body.values[0].length)}${r + body.values.length - 1}`, updatedRows: body.values.length } });
  }
  if (u.pathname.includes('/values/')) {
    const range = decodeURIComponent(u.pathname.split('/values/')[1]);
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body); const st = core.rangeStart(range);
      setRange(st, corrupt ? [['B1']] : body.values);
      const end = core.cellName(st, body.values.length - 1, body.values[0].length - 1);
      return j({ updatedRange: `${st.sheet || 'S'}!${core.cellName(st, 0, 0)}:${end}`, updatedCells: body.values.flat().length });
    }
    return j({ range, values: getRange(range, u.searchParams.get('valueRenderOption')) });
  }
  if (u.hostname === 'www.googleapis.com') return j({ files: [{ id: 'F1', name: '销售台账', modifiedTime: 'x', webViewLink: 'https://x' }] });
  if (init.method === 'POST') return j({ spreadsheetId: 'NEW', spreadsheetUrl: 'https://new', properties: { title: JSON.parse(init.body).properties.title }, sheets: [{ properties: { title: 'Sheet1' } }] });
  if (u.searchParams.get('includeGridData')) return j({ sheets: [{ data: [{ startRow: 0, startColumn: 1, rowData: [{ values: [{ formattedValue: '2,700', note: 'Promo price. Regular 2,900, until 31 Dec 2026', effectiveFormat: { textFormat: { foregroundColorStyle: { rgbColor: { red: 1 } } } } }, { formattedValue: 'x', effectiveFormat: { textFormat: { foregroundColorStyle: { rgbColor: {} } } } }] }] }] }] });
  return j({ properties: { title: 'T' }, sheets: [{ properties: { title: 'PSI', sheetId: 0, gridProperties: { rowCount: 100, columnCount: 10 } } }] });
};
const { apply } = await import('./index.js');
const tools = {};
apply({ logger: { info() {}, warn: console.log }, get: (k) => (k === 'tools' ? { register: (d) => { tools[d.name] = d; } } : undefined) }, { dataDir: dir, downloadsDir: dl });
assert.deepEqual(Object.keys(tools).sort(), ['gsheets_append', 'gsheets_connect', 'gsheets_create', 'gsheets_find', 'gsheets_info', 'gsheets_locate', 'gsheets_read', 'gsheets_write']);
assert.deepEqual(await tools.gsheets_connect.execute({}), { connected: true });
let r = await tools.gsheets_write.execute({ spreadsheet: 'SID', range: 'S!A1', values: [['DSH 测试', '2026-11-24'], ['数量', 2700]] });
assert.equal(r.verified, true, JSON.stringify(r));
corrupt = true;
r = await tools.gsheets_write.execute({ spreadsheet: 'SID', range: 'S!A1', values: [['DSH 测试', '2026-11-24']] });
assert.equal(r.verified, false); assert.equal(r.mismatches[0].cell, 'A1'); assert.equal(r.mismatches[0].got, 'B1');
corrupt = false;
r = await tools.gsheets_append.execute({ spreadsheet: 'SID', range: 'S!A:B', values: [['追加', 1]] });
assert.equal(r.verified, true); assert.equal(r.updatedRange, 'S!A3:B3');
r = await tools.gsheets_read.execute({ spreadsheet: 'https://docs.google.com/spreadsheets/d/SIDSIDSIDSIDSIDSIDSIDSID/edit', range: 'S!A1:B3', details: true });
assert.equal(r.rows, 3); assert.equal(r.values[1][1], '2,700');
assert.deepEqual(r.marked.cells[0], { cell: 'B1', value: '2,700', note: 'Promo price. Regular 2,900, until 31 Dec 2026', color: '#ff0000' });
assert.equal(r.marked.cells.length, 1);
assert.deepEqual(r.rowNumbers, [1, 2, 3]); assert.equal(r.firstRow, 1);
assert.equal((await tools.gsheets_find.execute({ query: "Bob's" })).files[0].id, 'F1');
assert.equal((await tools.gsheets_info.execute({ spreadsheet: 'SID' })).sheets[0].title, 'PSI');
r = await tools.gsheets_create.execute({ title: '新表', values: [['a']] });
assert.equal(r.id, 'NEW'); assert.equal(r.verified, true);
ok('七个工具：写入回读通过、写错能抓到、追加、读批注红字、找表、看页、新建');

// 6. 写前防护（2026-11-25 DSH 写表测试暴露的三类错：覆盖公式列、找错行、行号差一）
for (const k of Object.keys(sheet)) delete sheet[k];
setRange({ col: 1, row: 1 }, [['No', 'Project', 'Model', 'Date', 'Days'], [1, 'PJ-1', 'U-060A', '=DATE(2026,11,21)', '=TODAY()-D2'], [2, 'PJ-2', 'CH-391B-A', '=DATE(2026,11,24)', '=TODAY()-D3'], [3, '', '', '', '']]);
// 区域 3 列、数据 2 列 → 拒写
r = await tools.gsheets_write.execute({ spreadsheet: 'SID', range: 'S!C3:E3', values: [['x', 'y']] });
assert.equal(r.written, false); assert.equal(r.problems[0].problem, 'size'); assert.equal(sheet.C3, 'CH-391B-A');
// 覆盖公式 E3 → 拒写，表不变
r = await tools.gsheets_write.execute({ spreadsheet: 'SID', range: 'S!D3:E3', values: [['=DATE(2026,11,25)', 5]] });
assert.equal(r.written, false); assert.deepEqual(r.problems.map(p => p.cell), ['E3']); assert.equal(sheet.D3, '=DATE(2026,11,24)');
// 日期常量公式可以换成新日期
r = await tools.gsheets_write.execute({ spreadsheet: 'SID', range: 'S!D3', values: [['=DATE(2026,11,25)']], expect: { B3: 'PJ-2', C3: 'ch-391b-a ' } });
assert.equal(r.written, true, JSON.stringify(r)); assert.equal(sheet.D3, '=DATE(2026,11,25)');
// expect 对不上（找错了行）→ 拒写
r = await tools.gsheets_write.execute({ spreadsheet: 'SID', range: 'S!D2', values: [['=DATE(2026,11,25)']], expect: { B2: 'PJ-2' } });
assert.equal(r.written, false); assert.equal(r.problems[0].problem, 'expect'); assert.equal(sheet.D2, '=DATE(2026,11,21)');
// 按关键列找行、找下一空行
r = await tools.gsheets_locate.execute({ spreadsheet: 'SID', sheet: 'S', match: { B: 'pj-2', C: 'CH-391B-A' }, show: 'A:C', next_empty: 'B:E' });
assert.equal(r.count, 1); assert.equal(r.matches[0].row, 3); assert.equal(r.matches[0].values.B, 'PJ-2'); assert.equal(r.nextEmptyRow, 4); assert.equal(r.lastFilledRow, 3);
r = await tools.gsheets_locate.execute({ spreadsheet: 'SID', sheet: 'S', match: { B: 'PJ-9' } });
assert.equal(r.count, 0);
ok('写前防护：区域大小不符、覆盖公式、找错行都拒写；按关键列定位和找下一空行');

console.log(`\n全部通过：${pass} 项`);
