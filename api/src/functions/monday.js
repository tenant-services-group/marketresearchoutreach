'use strict';
/**
 * /api/monday — Monday.com sync for extracted properties.
 *
 *   GET  /api/monday/boards → { ok, workspaces:[{id,name}], boards:[{id,name,workspaceId,url}] }
 *   POST /api/monday/sync   → body:
 *        { target: {type:'new', workspaceId, name} | {type:'existing', boardId},
 *          rows: [{address, propertyName, leasingCompany, firstName, lastName, email, city, state, zip}] }
 *        → { ok, boardId, boardUrl, created, failed:[{address, error}] }
 *
 * Requires App Setting: MONDAY_API_TOKEN (Monday → avatar → Developers → My access tokens).
 * Debug: DEBUG_RESPONSE=true adds error detail to responses.
 */

const { app } = require('@azure/functions');

const MONDAY_URL = 'https://api.monday.com/v2';
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

async function monday(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    const err = new Error('MONDAY_API_TOKEN is not configured on the Static Web App.');
    err.statusCode = 503;
    throw err;
  }
  const res = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors && data.errors.length) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }
  if (data.error_message) throw new Error(data.error_message);
  return data.data;
}

// Standard column set created on new boards and ensured on existing ones (matched by title)
const COLUMNS = [
  { key: 'propertyName',   title: 'Property Name',   type: 'text' },
  { key: 'leasingCompany', title: 'Leasing Company', type: 'text' },
  { key: 'contact',        title: 'Contact',         type: 'text' },
  { key: 'email',          title: 'Email',           type: 'email' },
  { key: 'city',           title: 'City',            type: 'text' },
  { key: 'state',          title: 'State',           type: 'text' },
  { key: 'zip',            title: 'Zip',             type: 'text' },
  { key: 'status',         title: 'Status',          type: 'status' },
  { key: 'dateSent',       title: 'Date Sent',       type: 'date' },
];

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
      const status = err.statusCode === 503 ? 503 : 500;
      return json(status, {
        ok: false,
        error: status === 503
          ? 'Monday.com is not connected yet. Add MONDAY_API_TOKEN in the Static Web App settings.'
          : 'Monday.com sync failed: ' + String(err.message).slice(0, 300),
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
    contact:        (clean(r.firstName, 100) + ' ' + clean(r.lastName, 100)).trim(),
    email:          clean(r.email, 254),
    city:           clean(r.city, 100),
    state:          clean(r.state, 50),
    zip:            clean(r.zip, 20),
  })).filter(r => r.address || r.propertyName);
  if (!rows.length) return json(400, { ok: false, error: 'No rows with a property address were provided.' });

  // Resolve the board
  let boardId, boardUrl;
  if (target.type === 'new') {
    const name = clean(target.name, 120);
    if (!name) return json(400, { ok: false, error: 'Board name is required for a new board.' });
    const vars = { name };
    let q = 'mutation ($name: String!) { create_board (board_name: $name, board_kind: public) { id url } }';
    if (target.workspaceId) {
      vars.ws = String(target.workspaceId);
      q = 'mutation ($name: String!, $ws: ID!) { create_board (board_name: $name, board_kind: public, workspace_id: $ws) { id url } }';
    }
    const data = await monday(q, vars);
    boardId = String(data.create_board.id);
    boardUrl = data.create_board.url;
  } else if (target.type === 'existing') {
    boardId = clean(target.boardId, 30);
    if (!boardId) return json(400, { ok: false, error: 'boardId is required for an existing board.' });
  } else {
    return json(400, { ok: false, error: 'target.type must be "new" or "existing".' });
  }

  // Fetch current columns; create any missing standard columns; map key → column id
  const boardData = await monday(
    'query ($id: [ID!]) { boards (ids: $id) { id url columns { id title type } } }',
    { id: [boardId] }
  );
  const board = boardData.boards && boardData.boards[0];
  if (!board) return json(404, { ok: false, error: 'Board not found or the token has no access to it.' });
  boardUrl = boardUrl || board.url;

  const byTitle = {};
  (board.columns || []).forEach(c => { byTitle[c.title.trim().toLowerCase()] = c; });
  const colId = {};
  for (const col of COLUMNS) {
    const existing = byTitle[col.title.toLowerCase()];
    if (existing) {
      colId[col.key] = existing.id;
    } else {
      const created = await monday(
        'mutation ($board: ID!, $title: String!, $type: ColumnType!) { create_column (board_id: $board, title: $title, column_type: $type) { id } }',
        { board: boardId, title: col.title, type: col.type }
      );
      colId[col.key] = created.create_column.id;
    }
  }

  // Create items sequentially (Monday complexity budget); collect per-row failures
  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  const failed = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cv = {};
    cv[colId.propertyName]   = r.propertyName;
    cv[colId.leasingCompany] = r.leasingCompany;
    cv[colId.contact]        = r.contact;
    if (r.email) cv[colId.email] = { email: r.email, text: r.email };
    cv[colId.city]  = r.city;
    cv[colId.state] = r.state;
    cv[colId.zip]   = r.zip;
    cv[colId.status]   = { label: 'Sent' };
    cv[colId.dateSent] = { date: today };
    try {
      await monday(
        'mutation ($board: ID!, $name: String!, $cv: JSON!) { create_item (board_id: $board, item_name: $name, column_values: $cv, create_labels_if_missing: true) { id } }',
        { board: boardId, name: r.address || r.propertyName || ('Property ' + (i + 1)), cv: JSON.stringify(cv) }
      );
      created++;
    } catch (err) {
      failed.push({ address: r.address || r.propertyName, error: String(err.message).slice(0, 200) });
      context.error('item create failed:', err.message);
    }
    if ((i + 1) % 10 === 0) await new Promise(res => setTimeout(res, 300));
  }

  return json(200, { ok: true, boardId, boardUrl, created, failed });
}
