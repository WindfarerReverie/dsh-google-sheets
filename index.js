// dsh-google-sheets — DSH 插件入口：把 Google 表格接口注册成 gsheets_* 工具。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_SCOPE, readonlyIds, dataDir, findClientFile, readClient, tokenStore, accessToken, authorize, api, sheetId, rangeStart, compareGrid, flattenDetails, cellName, colToNum, numToCol, quoteSheet, preWriteProblems, norm } from './core.js';

export const name = 'google-sheets';
// 等 DSH 的工具服务就绪后再加载，否则注册不上
export const inject = ['tools'];

const MODE = { user: 'USER_ENTERED', raw: 'RAW' };
const obj = { type: 'object', additionalProperties: true };
const out = { schema: obj, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] };
const grid = { type: 'array', items: { type: 'array', items: {} }, description: '二维数组，一行一个数组，例如 [["型号","数量"],["SC-8028",3]]' };
const spreadsheet = { type: 'string', description: '表格 ID 或完整网址' };

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console;
  const dir = dataDir(config.dataDir);
  const store = tokenStore(dir);
  const maxCells = Number(config.maxCells) || 5000;
  let authing = null;

  const client = () => {
    const f = findClientFile(dir, config.downloadsDir);
    if (!f) throw new Error('没有 Google 授权凭据：把 client_secret_*.json 放进「下载」文件夹或 ' + dir + '\\client.json');
    return readClient(f);
  };
  const token = async () => {
    try { return await accessToken(client(), store); }
    catch (e) {
      if (e.message !== 'NOT_AUTHORIZED') throw e;
      throw new Error('还没授权 Google 表格：先调用 gsheets_connect，让用户在弹出的浏览器页面点“允许”。');
    }
  };
  const g = api(token);
  const readonly = (id) => readonlyIds(dir, config.downloadsDir).has(id)
    ? ['这张表在只读名单里（公司正本），本插件不写。要改请交给公司的写表机器人或正式值班。'] : null;

  // 写入后立即回读三种形式比对
  async function verify(id, range, values) {
    const { fmt, raw, formula } = await g.grid(id, range);
    const bad = compareGrid(values, fmt, raw, formula, rangeStart(range));
    return { verified: bad.length === 0, mismatches: bad.slice(0, 50), readBack: fmt.slice(0, 20) };
  }

  const fileId = (v) => { const m = String(v || '').match(/[-\w]{25,}/); if (!m) throw new Error('看不懂的文件或文件夹：给 ID 或网址'); return m[0]; };
  const needDocs = () => { if (!String(store.load()?.scope || '').includes(DOCS_SCOPE)) throw new Error('还没授权读 Drive 文档：先调用 gsheets_connect，让用户在弹出的页面点“允许”（多了一项“查看 Drive 文件”）。'); };
  const maxChars = Number(config.maxDocChars) || 120000;
  const defs = [
    {
      name: 'gdocs_read',
      description: '在线读 Google Drive 里一份 Google 文档的最新版（只读，不下载到本机），返回全文（Markdown）。file 写文件 ID 或网址。知识库这类规则文档用它读；不要用它改任何东西。',
      parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false },
      async execute(a) { needDocs(); const d = await g.readDoc(fileId(a.file)); if (d.text && d.text.length > maxChars) { d.text = d.text.slice(0, maxChars); d.truncated = true; } return d; },
    },
    {
      name: 'gdrive_list',
      description: '列出 Google Drive 某个文件夹里的文件（只读）：folder 写文件夹 ID 或网址；query 写名字里包含的字（可只写 query 全盘按名字找）。返回 id、名字、类型、修改时间。',
      parameters: { type: 'object', properties: { folder: { type: 'string' }, query: { type: 'string' }, max: { type: 'integer' } }, additionalProperties: false },
      async execute(a) { needDocs(); if (!a?.folder && !a?.query) throw new Error('给 folder 或 query'); return { files: await g.list(a.folder ? fileId(a.folder) : '', a.query || '', a.max || 50) }; },
    },
    {
      name: 'gsheets_connect',
      description: '连接 Google 表格（第一次用或授权失效时）。会在用户电脑上打开 Google 授权页，用户点“允许”后返回。已连接就直接返回 connected。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        // 旧授权没有读 Drive 文档的权限（0.3.0 起要 drive.readonly）：重新授权一次
        const hasDocs = String(store.load()?.scope || '').includes(DOCS_SCOPE);
        if (hasDocs) { try { await accessToken(client(), store); return { connected: true }; } catch (e) { if (e.message !== 'NOT_AUTHORIZED') throw e; } }
        authing ??= authorize(client(), { onUrl: (u) => log.info('google-sheets: 授权页 ' + u.slice(0, 80) + '…') }).then(t => { store.save(t); return t; }).finally(() => { authing = null; });
        await authing;
        return { connected: true, note: '授权完成' };
      },
    },
    {
      name: 'gsheets_find',
      description: '按名字找 Google 表格（只列表格，按最近修改排序）。返回 id、名字、网址。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '名字里包含的字，可留空' }, max: { type: 'integer' } }, additionalProperties: false },
      async execute(a) { return { files: await g.find(a?.query || '', a?.max || 10) }; },
    },
    {
      name: 'gsheets_info',
      description: '看一张表格有哪些工作表（页名、行数、列数）。读写前不确定页名时先用它。',
      parameters: { type: 'object', properties: { spreadsheet }, required: ['spreadsheet'], additionalProperties: false },
      async execute(a) { return g.info(sheetId(a.spreadsheet)); },
    },
    {
      name: 'gsheets_read',
      description: '读一个区域的值。range 用 A1 写法，带页名，如 "PSI!A1:H50"。返回的 rowNumbers 是每一行在表上的真实行号——要写哪一行就用它，不要自己数下标；按关键列找行优先用 gsheets_locate。render: formatted（默认，和表上看到的一样）/ raw（数字不带格式）/ formula（看公式）。details=true 时另外返回带批注、字体颜色、底色、删除线的单元格（只列有这些标记的格子）；表里用批注或红字标注重要信息时要开。只读需要的范围，不要整页读。',
      parameters: { type: 'object', properties: { spreadsheet, range: { type: 'string' }, render: { type: 'string', enum: ['formatted', 'raw', 'formula'] }, details: { type: 'boolean' } }, required: ['spreadsheet', 'range'], additionalProperties: false },
      async execute(a) {
        const id = sheetId(a.spreadsheet);
        const r = await g.get(id, a.range, { raw: 'UNFORMATTED_VALUE', formula: 'FORMULA' }[a.render] || 'FORMATTED_VALUE');
        let cells = 0; const values = [];
        for (const row of r.values) { if (cells + row.length > maxCells) break; values.push(row); cells += row.length; }
        const st = rangeStart(r.range || a.range);
        const res = { range: r.range, rows: values.length, firstRow: st.row, firstColumn: numToCol(st.col), rowNumbers: values.map((_, i) => st.row + i), values, truncated: values.length < r.values.length };
        if (a.details) Object.assign(res, { marked: flattenDetails(await g.details(id, a.range), maxCells) });
        return res;
      },
    },
    {
      name: 'gsheets_locate',
      description: '按关键列的值找行，返回真实行号（写表前用它定位，不要自己数）。match 写 {"列字母": "值"}，几列都要相等才算（不分大小写、忽略首尾空格），例如 {"A":"PI-JEPH-20261158","J":"CH-391B-A"}。show 写要一起返回的列，如 "A:P"。next_empty 写一组列（如 "B:J"）时，另外返回这几列最后一个有内容的行之后的第一行（新增记录写在这里）。',
      parameters: { type: 'object', properties: { spreadsheet, sheet: { type: 'string', description: '页名' }, match: { type: 'object', additionalProperties: true }, show: { type: 'string' }, next_empty: { type: 'string' } }, required: ['spreadsheet', 'sheet'], additionalProperties: false },
      async execute(a) {
        const id = sheetId(a.spreadsheet), q = quoteSheet(a.sheet), res = {};
        const keys = Object.entries(a.match || {}).map(([c, v]) => [c.toUpperCase().replace(/[^A-Z]/g, ''), v]);
        if (keys.length) {
          const cols = (await g.batchGet(id, keys.map(([c]) => `${q}!${c}:${c}`))).map(values => ({ values }));
          const n = Math.max(...cols.map(x => x.values.length));
          const rows = [];
          for (let i = 0; i < n; i++) if (keys.every(([, v], k) => norm(cols[k].values[i]?.[0]) === norm(v))) rows.push(i + 1);
          const show = (a.show || 'A:Z').toUpperCase().split(':');
          const shown = await g.batchGet(id, rows.slice(0, 20).map(row => `${q}!${show[0]}${row}:${show[1] || show[0]}${row}`));
          const matches = rows.slice(0, 20).map((row, k) => {
            const o = {}; (shown[k]?.[0] || []).forEach((x, i) => { o[numToCol(colToNum(show[0]) + i)] = x; });
            return { row, values: o };
          });
          Object.assign(res, { count: rows.length, matches, note: rows.length === 1 ? '找到唯一一行' : rows.length ? '找到多行，先弄清是哪一行再写' : '没找到，不要写' });
        }
        if (a.next_empty) {
          const [c1, c2] = a.next_empty.toUpperCase().split(':');
          const v = (await g.get(id, `${q}!${c1}:${c2 || c1}`, 'FORMATTED_VALUE')).values;
          let last = 0; v.forEach((r, i) => { if ((r || []).some(x => String(x ?? '').trim() !== '')) last = i + 1; });
          const lastVals = last ? (await g.get(id, `${q}!A${last}:${c2 || c1}${last}`, 'FORMATTED_VALUE')).values[0] : [];
          Object.assign(res, { lastFilledRow: last, lastFilledValues: lastVals, nextEmptyRow: last + 1 });
        }
        return res;
      },
    },
    {
      name: 'gsheets_write',
      description: '把二维数组写进一个区域（覆盖原内容），写完自动回读比对，verified=false 表示有格子没写对。写前自动检查，不通过就一格都不写（written=false，problems 说明原因）：①range 写了终点时，区域大小必须和 values 完全一样；②目标格里原来是公式的不覆盖（=DATE(年,月,日) 这种日期除外；确实要改公式才用 allow_formula_overwrite）；③expect 填了就先核对那些格子，例如 {"C83":"PJ-202607-013","G83":"CH-391B-A"}，对不上说明找错行。mode: user（默认，日期、数字、公式会被识别）/ raw（原样存成文字）。',
      parameters: { type: 'object', properties: { spreadsheet, range: { type: 'string' }, values: grid, mode: { type: 'string', enum: ['user', 'raw'] }, expect: { type: 'object', additionalProperties: true, description: '写前要核对的格子：{"格子":"应有的值"}' }, allow_formula_overwrite: { type: 'boolean' } }, required: ['spreadsheet', 'range', 'values'], additionalProperties: false },
      async execute(a) {
        const id = sheetId(a.spreadsheet);
        const ro = readonly(id); if (ro) return { written: false, verified: false, problems: ro };
        if (!Array.isArray(a.values) || !a.values.length) throw new Error('values 不能为空');
        const st = rangeStart(a.range), width = Math.max(...a.values.map(r => (r || []).length));
        const target = `${st.sheet ? st.sheet + '!' : ''}${cellName(st, 0, 0)}:${cellName(st, a.values.length - 1, width - 1)}`;
        const fo = (await g.get(id, target, 'FORMULA')).values;
        const expectCells = a.expect || {}, expectGot = {};
        const ek = Object.keys(expectCells);
        const got = await g.batchGet(id, ek.map(cell => `${st.sheet ? st.sheet + '!' : ''}${cell.toUpperCase().replace(/^.*!/, '')}`));
        ek.forEach((cell, i) => { expectGot[cell.toUpperCase()] = got[i]?.[0]?.[0]; });
        const problems = preWriteProblems({ range: a.range, values: a.values, formulas: fo, expectCells: Object.fromEntries(Object.entries(expectCells).map(([k, v]) => [k.toUpperCase(), v])), expectGot, allowFormula: !!a.allow_formula_overwrite });
        if (problems.length) return { written: false, verified: false, problems };
        const r = await g.update(id, a.range, a.values, MODE[a.mode] || MODE.user);
        const v = await verify(id, r.updatedRange || a.range, a.values);
        return { written: true, updatedRange: r.updatedRange, updatedCells: r.updatedCells, ...v };
      },
    },
    {
      name: 'gsheets_append',
      description: '在某页已有数据的下面追加几行（不覆盖已有内容），写完自动回读比对。range 写页名或表头区域，如 "群发outbox!A:G"。',
      parameters: { type: 'object', properties: { spreadsheet, range: { type: 'string' }, values: grid, mode: { type: 'string', enum: ['user', 'raw'] } }, required: ['spreadsheet', 'range', 'values'], additionalProperties: false },
      async execute(a) {
        const id = sheetId(a.spreadsheet);
        const ro = readonly(id); if (ro) return { written: false, verified: false, problems: ro };
        const r = await g.append(id, a.range, a.values, MODE[a.mode] || MODE.user);
        const range = r.updates?.updatedRange;
        const v = range ? await verify(id, range, a.values) : { verified: false, mismatches: [{ cell: '?', wrote: '', got: '接口没返回写入位置' }] };
        return { updatedRange: range, updatedRows: r.updates?.updatedRows, ...v };
      },
    },
    {
      name: 'gsheets_create',
      description: '新建一张 Google 表格，可同时写入首批数据（写完回读比对）。返回 id 和网址。',
      parameters: { type: 'object', properties: { title: { type: 'string' }, sheetTitle: { type: 'string' }, values: grid }, required: ['title'], additionalProperties: false },
      async execute(a) {
        const r = await g.create(a.title, a.sheetTitle);
        const res = { id: r.spreadsheetId, url: r.spreadsheetUrl, title: r.properties?.title };
        if (Array.isArray(a.values) && a.values.length) {
          const range = `'${r.sheets?.[0]?.properties?.title || a.sheetTitle || 'Sheet1'}'!A1`;
          const u = await g.update(r.spreadsheetId, range, a.values, MODE.user);
          Object.assign(res, await verify(r.spreadsheetId, u.updatedRange, a.values));
        }
        return res;
      },
    },
  ].map(d => ({ ...d, output: out, execute: async (args, exec) => d.execute(args || {}, exec) }));

  const tools = ctx.tools ?? ctx.get?.('tools');
  if (typeof tools?.register !== 'function') { log.warn('google-sheets: tools 服务不可用'); try { writeFileSync(join(dir, 'status.json'), JSON.stringify({ at: new Date().toISOString(), state: 'no-tools-service' })); } catch {} return; }
  for (const d of defs) { try { tools.register(d); } catch (e) { log.warn(`google-sheets: 注册 ${d.name} 失败：${e.message}`); } }
  log.info('google-sheets: 已注册 ' + defs.map(d => d.name).join(', '));
  try { writeFileSync(join(dir, 'status.json'), JSON.stringify({ at: new Date().toISOString(), state: 'registered', tools: defs.map(d => d.name) })); } catch {}
}
