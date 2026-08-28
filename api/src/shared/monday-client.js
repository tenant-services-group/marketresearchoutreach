'use strict';
/**
 * Shared Monday.com client + the canonical outreach board schema
 * (matches the Research Outreach Board example: 17 columns, Name = property address).
 *
 * Requires App Setting: MONDAY_API_TOKEN.
 */

const MONDAY_URL = 'https://api.monday.com/v2';

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

// Canonical board schema. Item name = property address ("Name" in the example export).
const COLUMNS = [
  { key: 'propertyName',      title: 'Property Name',        type: 'text' },
  { key: 'contactEmail',      title: 'Contact Email',        type: 'email' },
  { key: 'emailStatus',       title: 'Email Status',         type: 'status' },
  { key: 'dataStatus',        title: 'Data Status',          type: 'status' },
  { key: 'affirmatives',      title: 'Affirmatives',         type: 'status' },
  { key: 'eliminationReason', title: 'Elimination Reason',   type: 'status' },
  { key: 'notes',             title: 'Notes',                type: 'long_text' },
  { key: 'squareFootage',     title: 'Square footage',       type: 'text' },
  { key: 'flyerLink',         title: 'Flyer Link',           type: 'link' },
  { key: 'file',              title: 'File',                 type: 'file', aliases: ['files', 'flyer attachment'], matchType: 'file' },
  { key: 'emailsSent',        title: 'Emails Sent',          type: 'date' },
  { key: 'followUpDate',      title: 'Follow Up Date',       type: 'date' },
  { key: 'emailReceivedDate', title: 'Email Received Date',  type: 'date' },
  { key: 'leasingCompany',    title: 'Leasing Company Name', type: 'text' },
  { key: 'firstName',         title: 'First Name',           type: 'text' },
  { key: 'lastName',          title: 'Last Name',            type: 'text' },
  { key: 'city',              title: 'City',                 type: 'text' },
];

/** Create a board (optionally in a workspace) and return { boardId, boardUrl }. */
async function createBoard(name, workspaceId) {
  const vars = { name };
  let q = 'mutation ($name: String!) { create_board (board_name: $name, board_kind: public) { id url } }';
  if (workspaceId) {
    vars.ws = String(workspaceId);
    q = 'mutation ($name: String!, $ws: ID!) { create_board (board_name: $name, board_kind: public, workspace_id: $ws) { id url } }';
  }
  const data = await monday(q, vars);
  return { boardId: String(data.create_board.id), boardUrl: data.create_board.url };
}

/**
 * Map the schema onto a board's existing columns (matched by title, then by type).
 *
 * Columns are created only when `allowCreate` is true — i.e. on a board this tool
 * just created. Updating an existing board never alters its structure: create_column
 * needs board-owner rights, so requiring it to add rows made every run fail with
 * "User unauthorized to perform action" on boards whose edit permission is "owners".
 * A column the board does not have is simply left unmapped and its value skipped.
 *
 * Returns { colId: {key -> column id}, colType: {key -> column type}, boardUrl }.
 */
async function ensureColumns(boardId, allowCreate) {
  const boardData = await monday(
    'query ($id: [ID!]) { boards (ids: $id) { id url columns { id title type } } }',
    { id: [boardId] }
  );
  const board = boardData.boards && boardData.boards[0];
  if (!board) {
    const err = new Error('Board not found or the token has no access to it.');
    err.statusCode = 404;
    throw err;
  }
  const columns = board.columns || [];
  const byTitle = {};
  columns.forEach(c => { byTitle[c.title.trim().toLowerCase()] = c; });

  const taken = new Set();
  const colId = {};
  const colType = {};
  for (const col of COLUMNS) {
    const titles = [col.title.toLowerCase()].concat(col.aliases || []);
    let existing = titles.map(t => byTitle[t]).find(Boolean);
    // No title match: reuse the board's own column of this type rather than
    // adding a duplicate under our name.
    if (!existing && col.matchType) {
      existing = columns.find(c => c.type === col.matchType && !taken.has(c.id));
    }
    if (existing) {
      taken.add(existing.id);
      colId[col.key] = existing.id;
      colType[col.key] = existing.type;
      continue;
    }
    if (!allowCreate) continue;
    const created = await monday(
      'mutation ($board: ID!, $title: String!, $type: ColumnType!) { create_column (board_id: $board, title: $title, column_type: $type) { id } }',
      { board: boardId, title: col.title, type: col.type }
    );
    colId[col.key] = created.create_column.id;
    colType[col.key] = col.type;
  }
  return { colId, colType, boardUrl: board.url };
}

/** List all items (id + name) on a board, up to 500. */
async function listItems(boardId) {
  const data = await monday(
    'query ($id: [ID!]) { boards (ids: $id) { items_page (limit: 500) { items { id name } } } }',
    { id: [boardId] }
  );
  const board = data.boards && data.boards[0];
  return (board && board.items_page && board.items_page.items) || [];
}

/** Create an item; groupId is optional — Monday's first group is used without it. */
async function createItem(boardId, name, columnValues, groupId) {
  const vars = { board: boardId, name, cv: JSON.stringify(columnValues) };
  let q = 'mutation ($board: ID!, $name: String!, $cv: JSON!) { create_item (board_id: $board, item_name: $name, column_values: $cv, create_labels_if_missing: true) { id } }';
  if (groupId) {
    vars.group = String(groupId);
    q = 'mutation ($board: ID!, $group: String!, $name: String!, $cv: JSON!) { create_item (board_id: $board, group_id: $group, item_name: $name, column_values: $cv, create_labels_if_missing: true) { id } }';
  }
  const data = await monday(q, vars);
  return String(data.create_item.id);
}

async function updateItem(boardId, itemId, columnValues) {
  await monday(
    'mutation ($board: ID!, $item: ID!, $cv: JSON!) { change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cv, create_labels_if_missing: true) { id } }',
    { board: boardId, item: itemId, cv: JSON.stringify(columnValues) }
  );
}

/** Upload a file to an item's file column (Monday multipart endpoint). */
async function addFileToItem(itemId, columnId, filename, buffer) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    const err = new Error('MONDAY_API_TOKEN is not configured on the Static Web App.');
    err.statusCode = 503;
    throw err;
  }
  const fd = new FormData();
  fd.append('query',
    'mutation ($file: File!) { add_file_to_column (item_id: ' + Number(itemId) +
    ', column_id: ' + JSON.stringify(String(columnId)) + ', file: $file) { id } }');
  fd.append('variables[file]', new Blob([buffer]), filename || 'attachment.pdf');
  const res = await fetch('https://api.monday.com/v2/file', {
    method: 'POST',
    headers: { 'Authorization': token, 'API-Version': '2024-10' },
    body: fd,
  });
  const data = await res.json();
  if (data.errors && data.errors.length) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }
  return data.data;
}

module.exports = { monday, COLUMNS, createBoard, ensureColumns, listItems, createItem, updateItem, addFileToItem };
