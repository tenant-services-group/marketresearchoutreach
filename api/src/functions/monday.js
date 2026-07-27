'use strict';
/**
 * /api/monday — Monday.com board listing + property sync.
 *
 *   GET  /api/monday/boards → { ok, workspaces:[{id,name}], boards:[{id,name,workspaceId,url}] }
 *   POST /api/monday/sync   → body:
 *        { target: {type:'new', workspaceId, name} | {type:'existing', boardId},
 *          rows: [{address, propertyName, leasingCompany, firstName, lastName, email, city}] }
 *        → { ok, boardId, boardUrl, created, failed:[{address, error}] }
 *
 * Boards use the canonical Research Outreach schema (see shared/monday-client.js).
 * Synced items get Email Status "*Email Sent" and Emails Sent = today.
 */

const { app } = require('@azure/functions');
const { monday, createBoard, ensureColumns, createItem } = require('../shared/monday-client');

const MAX_ROWS = 500;

const clean = (v, max) =>
  String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const debugInfo = (err) =>
  process.env.DEBUG_RESPONSE === 'true' ? String(err && err.message).slice(0, 600) : undefined;

app.http('monday', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'monday/{action}',
  handler: async (request, context) => {
    try {
      const action = (request.params.action || '').toLowerCase();
      if (request.method === 'GET' && action === 'boards') return await listBoards();
      if (request.method === 'POST' && action === 'sync') return await syncRows(request, context);
      return json(404, { ok: false, error: 'Unknown action.' });
    } catch (err) {
      context.error('monday API error:', err.message);
      const status = err.statusCode === 503 ? 503 : (err.statusCode === 404 ? 404 : 500);
      return json(status, {
        ok: false,
        error: status === 503
          ? 'Monday.com is not connected yet. Add MONDAY_API_TOKEN in the Static Web App settings.'
          : 'Monday.com request failed: ' + String(err.message).slice(0, 300),
        debug: debugInfo(err),
      });
    }
  },
});

async function listBoards() {
  const data = await monday(`
    query {
      workspaces (limit: 100) { id name }
      boards (limit: 200, order_by: created_at) {
        id name url board_kind type
        workspace { id }
      }
    }`);
  const workspaces = (data.workspaces || []).filter(Boolean).map(w => ({ id: String(w.id), name: w.name }));
  const boards = (data.boards || [])
    .filter(b => b && b.type === 'board' && b.board_kind !== 'private_template')
    .map(b => ({
      id: String(b.id),
      name: b.name,
      url: b.url,
      workspaceId: b.workspace ? String(b.workspace.id) : null,
    }));
  return json(200, { ok: true, workspaces, boards });
}

async function syncRows(request, context) {
  let body = {};
  try { body = await request.json(); } catch (err) {}

  const target = body.target || {};
  const rawRows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  const rows = rawRows.map(r => ({
    address:        clean(r.address, 255),
    propertyName:   clean(r.propertyName, 255),
    leasingCompany: clean(r.leasingCompany, 255),
    firstName:      clean(r.firstName, 100),
    lastName:       clean(r.lastName, 100),
    email:          clean(r.email, 254),
    city:           clean(r.city, 100),
  })).filter(r => r.address || r.propertyName);
  if (!rows.length) return json(400, { ok: false, error: 'No rows with a property address were provided.' });

  let boardId, boardUrl;
  if (target.type === 'new') {
    const name = clean(target.name, 120);
    if (!name) return json(400, { ok: false, error: 'Board name is required for a new board.' });
    ({ boardId, boardUrl } = await createBoard(name, target.workspaceId));
  } else if (target.type === 'existing') {
    boardId = clean(target.boardId, 30);
    if (!boardId) return json(400, { ok: false, error: 'boardId is required for an existing board.' });
  } else {
    return json(400, { ok: false, error: 'target.type must be "new" or "existing".' });
  }

  const ensured = await ensureColumns(boardId);
  const colId = ensured.colId;
  boardUrl = boardUrl || ensured.boardUrl;

  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  const failed = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cv = {};
    cv[colId.propertyName]   = r.propertyName;
    if (r.email) cv[colId.contactEmail] = { email: r.email, text: r.email };
    cv[colId.emailStatus]    = { label: '*Email Sent' };
    cv[colId.emailsSent]     = { date: today };
    cv[colId.leasingCompany] = r.leasingCompany;
    cv[colId.firstName]      = r.firstName;
    cv[colId.lastName]       = r.lastName;
    cv[colId.city]           = r.city;
    try {
      await createItem(boardId, r.address || r.propertyName || ('Property ' + (i + 1)), cv);
      created++;
    } catch (err) {
      failed.push({ address: r.address || r.propertyName, error: String(err.message).slice(0, 200) });
      context.error('item create failed:', err.message);
    }
    if ((i + 1) % 10 === 0) await new Promise(res => setTimeout(res, 300));
  }

  return json(200, { ok: true, boardId, boardUrl, created, failed });
}
