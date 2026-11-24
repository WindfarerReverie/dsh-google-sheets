// dsh-google-sheets — DSH 插件入口：把 Google 表格接口注册成 gsheets_* 工具。
import { dataDir, findClientFile, readClient, tokenStore, accessToken, authorize, api, sheetId, rangeStart, compareGrid, flattenDetails } from './core.js';

export const name = 'google-sheets';

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

  // 写入后立即回读三种形式比对
  async function verify(id, range, values) {
    const [f, u, fo] = await Promise.all([g.get(id, range, 'FORMATTED_VALUE'), g.get(id, range, 'UNFORMATTED_VALUE'), g.get(id, range, 'FORMULA')]);
    const bad = compareGrid(values, f.values, u.values, fo.values, rangeStart(range));
    return { verified: bad.length === 0, mismatches: bad.slice(0, 50), readBack: f.values.slice(0, 20) };
  }

  const defs = [
    {
      name: 'gsheets_connect',
      description: '连接 Google 表格（第一次用或授权失效时）。会在用户电脑上打开 Google 授权页，用户点“允许”后返回。已连接就直接返回 connected。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        try { await accessToken(client(), store); return { connected: true }; } catch (e) { if (e.message !== 'NOT_AUTHORIZED') throw e; }
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
      description: '读一个区域的值。range 用 A1 写法，带页名，如 "PSI!A1:H50"。render: formatted（默认，和表上看到的一样）/ raw（数字不带格式）/ formula（看公式）。details=true 时另外返回带批注、字体颜色、底色、删除线的单元格（只列有这些标记的格子）；表里用批注或红字标注重要信息时要开。只读需要的范围，不要整页读。',
      parameters: { type: 'object', properties: { spreadsheet, range: { type: 'string' }, render: { type: 'string', enum: ['formatted', 'raw', 'formula'] }, details: { type: 'boolean' } }, required: ['spreadsheet', 'range'], additionalProperties: false },
      async execute(a) {
        const id = sheetId(a.spreadsheet);
        const r = await g.get(id, a.range, { raw: 'UNFORMATTED_VALUE', formula: 'FORMULA' }[a.render] || 'FORMATTED_VALUE');
        let cells = 0; const values = [];
        for (const row of r.values) { if (cells + row.length > maxCells) break; values.push(row); cells += row.length; }
        const res = { range: r.range, rows: values.length, values, truncated: values.length < r.values.length };
        if (a.details) Object.assign(res, { marked: flattenDetails(await g.details(id, a.range), maxCells) });
        return res;
      },
    },
    {
      name: 'gsheets_write',
      description: '把二维数组写进一个区域（覆盖原内容），写完自动回读比对，verified=false 表示有格子没写对，mismatches 列出哪格写了什么、表上是什么。mode: user（默认，和手打一样，日期、数字、公式会被识别）/ raw（原样存成文字）。range 只写起点也行，如 "PSI!B5"。',
      parameters: { type: 'object', properties: { spreadsheet, range: { type: 'string' }, values: grid, mode: { type: 'string', enum: ['user', 'raw'] } }, required: ['spreadsheet', 'range', 'values'], additionalProperties: false },
      async execute(a) {
        const id = sheetId(a.spreadsheet);
        if (!Array.isArray(a.values) || !a.values.length) throw new Error('values 不能为空');
        const r = await g.update(id, a.range, a.values, MODE[a.mode] || MODE.user);
        const v = await verify(id, r.updatedRange || a.range, a.values);
        return { updatedRange: r.updatedRange, updatedCells: r.updatedCells, ...v };
      },
    },
    {
      name: 'gsheets_append',
      description: '在某页已有数据的下面追加几行（不覆盖已有内容），写完自动回读比对。range 写页名或表头区域，如 "群发outbox!A:G"。',
      parameters: { type: 'object', properties: { spreadsheet, range: { type: 'string' }, values: grid, mode: { type: 'string', enum: ['user', 'raw'] } }, required: ['spreadsheet', 'range', 'values'], additionalProperties: false },
      async execute(a) {
        const id = sheetId(a.spreadsheet);
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

  const tools = ctx.get?.('tools');
  if (typeof tools?.register !== 'function') { log.warn('google-sheets: tools 服务不可用'); return; }
  for (const d of defs) { try { tools.register(d); } catch (e) { log.warn(`google-sheets: 注册 ${d.name} 失败：${e.message}`); } }
  log.info('google-sheets: 已注册 ' + defs.map(d => d.name).join(', '));
}
