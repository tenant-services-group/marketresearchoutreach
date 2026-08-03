'use strict';
/**
 * /api/projects — outreach project store (phase 1 of response reporting).
 *
 *   GET    /api/projects        → list projects (newest first, summary fields)
 *   GET    /api/projects/{id}   → one project including its drafts
 *   POST   /api/projects        → save a project at generate time
 *                                 body: { name, subjects:[..], drafts:[{email,name,subject}] }
 *   PUT    /api/projects/{id}   → replace an existing project's name/subjects/drafts
 *                                 (used when drafts are regenerated, so a re-generate
 *                                 updates the same project instead of duplicating it).
 *                                 Opened flags are carried forward by email address.
 *   PATCH  /api/projects/{id}   → mark drafts opened
 *                                 body: { openedEmails:["a@b.com", ...] }
 *   DELETE /api/projects/{id}   → delete a project
 *
 * Debug: set DEBUG_RESPONSE=true on the SWA to include error detail in responses.
 */

const { app } = require('@azure/functions');
const { getClient, ensureTable, newId, PARTITION } = require('../shared/store');

const LIMITS = {
  name: 120,
  subject: 500,
  email: 254,
  contactName: 120,
  maxDrafts: 500,
  maxSubjects: 50,
  listTop: 200,
};

const clean = (v, max) =>
  String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const debugInfo = (err) =>
  process.env.DEBUG_RESPONSE === 'true' ? String(err && err.message).slice(0, 600) : undefined;

app.http('projects', {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  route: 'projects/{id?}',
  handler: async (request, context) => {
    try {
      await ensureTable();
      const id = request.params.id || '';

      if (request.method === 'GET' && !id) return await listProjects();
      if (request.method === 'GET') return await getProject(id);
      if (request.method === 'POST') return await createProject(request);
      if (request.method === 'PUT') return await replaceProject(request, id);
      if (request.method === 'PATCH') return await markOpened(request, id);
      if (request.method === 'DELETE') return await deleteProject(id);
      return json(405, { ok: false, error: 'Method not allowed.' });
    } catch (err) {
      context.error('projects API error:', err.message);
      const status = err.statusCode === 503 ? 503 : 500;
      return json(status, {
        ok: false,
        error: status === 503
          ? 'Project storage is not configured yet. Add STORAGE_CONNECTION_STRING in the Static Web App settings.'
          : 'Something went wrong saving or loading projects.',
        debug: debugInfo(err),
      });
    }
  },
});

async function listProjects() {
  const client = getClient();
  const items = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const e of iter) {
    let opened = 0;
    try { opened = JSON.parse(e.draftsJson || '[]').filter(d => d.opened).length; } catch (err) {}
    items.push({
      id: e.rowKey,
      name: e.name || '(unnamed)',
      createdAt: e.createdAt || '',
      draftCount: e.draftCount || 0,
      openedCount: opened,
    });
    if (items.length >= LIMITS.listTop) break;
  }
  // RowKeys are reverse-chronological, so iteration order is already newest first
  return json(200, { ok: true, projects: items });
}

async function getProject(id) {
  const client = getClient();
  try {
    const e = await client.getEntity(PARTITION, id);
    let drafts = [];
    try { drafts = JSON.parse(e.draftsJson || '[]'); } catch (err) {}
    let subjects = [];
    try { subjects = JSON.parse(e.subjectsJson || '[]'); } catch (err) {}
    return json(200, {
      ok: true,
      project: { id: e.rowKey, name: e.name, createdAt: e.createdAt, subjects, drafts },
    });
  } catch (err) {
    if (err.statusCode === 404) return json(404, { ok: false, error: 'Project not found.' });
    throw err;
  }
}

// Shared body parsing for POST (create) and PUT (replace).
// Returns { error } on a validation failure, otherwise { name, drafts, subjects }.
async function readProjectBody(request) {
  let body = {};
  try { body = await request.json(); } catch (err) {}

  const name = clean(body.name, LIMITS.name);
  if (!name) return { error: 'Project name is required.' };

  const rawDrafts = Array.isArray(body.drafts) ? body.drafts.slice(0, LIMITS.maxDrafts) : [];
  const drafts = rawDrafts
    .map(d => ({
      email: clean(d.email, LIMITS.email).toLowerCase(),
      name: clean(d.name, LIMITS.contactName),
      subject: clean(d.subject, LIMITS.subject),
      opened: false,
      openedAt: '',
    }))
    .filter(d => d.email);
  if (!drafts.length) return { error: 'No drafts with an email address were provided.' };

  const subjects = (Array.isArray(body.subjects) ? body.subjects : [])
    .slice(0, LIMITS.maxSubjects)
    .map(s => clean(s, LIMITS.subject))
    .filter(Boolean);

  return { name, drafts, subjects };
}

async function createProject(request) {
  const parsed = await readProjectBody(request);
  if (parsed.error) return json(400, { ok: false, error: parsed.error });

  const id = newId();
  await getClient().createEntity({
    partitionKey: PARTITION,
    rowKey: id,
    name: parsed.name,
    createdAt: new Date().toISOString(),
    draftCount: parsed.drafts.length,
    draftsJson: JSON.stringify(parsed.drafts),
    subjectsJson: JSON.stringify(parsed.subjects),
  });
  return json(200, { ok: true, id });
}

// Regenerating drafts updates the project in place instead of writing a second
// row for the same send. Contacts that already opened a draft keep that status
// as long as they are still on the regenerated list. createdAt is untouched.
async function replaceProject(request, id) {
  if (!id) return json(400, { ok: false, error: 'Project id is required.' });

  const parsed = await readProjectBody(request);
  if (parsed.error) return json(400, { ok: false, error: parsed.error });

  const client = getClient();
  let entity;
  try {
    entity = await client.getEntity(PARTITION, id);
  } catch (err) {
    if (err.statusCode === 404) return json(404, { ok: false, error: 'Project not found.' });
    throw err;
  }

  let previous = [];
  try { previous = JSON.parse(entity.draftsJson || '[]'); } catch (err) {}
  const openedBefore = new Map();
  previous.forEach(d => { if (d && d.opened) openedBefore.set(d.email, d.openedAt || ''); });

  const drafts = parsed.drafts.map(d =>
    openedBefore.has(d.email)
      ? Object.assign({}, d, { opened: true, openedAt: openedBefore.get(d.email) })
      : d
  );

  await client.updateEntity(
    {
      partitionKey: PARTITION,
      rowKey: id,
      name: parsed.name,
      draftCount: drafts.length,
      draftsJson: JSON.stringify(drafts),
      subjectsJson: JSON.stringify(parsed.subjects),
    },
    'Merge'
  );
  return json(200, { ok: true, id });
}

async function deleteProject(id) {
  if (!id) return json(400, { ok: false, error: 'Project id is required.' });
  try {
    await getClient().deleteEntity(PARTITION, id);
  } catch (err) {
    if (err.statusCode === 404) return json(404, { ok: false, error: 'Project not found.' });
    throw err;
  }
  return json(200, { ok: true, id });
}

async function markOpened(request, id) {
  if (!id) return json(400, { ok: false, error: 'Project id is required.' });
  let body = {};
  try { body = await request.json(); } catch (err) {}
  const openedEmails = (Array.isArray(body.openedEmails) ? body.openedEmails : [])
    .map(e => clean(e, LIMITS.email).toLowerCase())
    .filter(Boolean);
  if (!openedEmails.length) return json(400, { ok: false, error: 'openedEmails is required.' });

  const client = getClient();
  let entity;
  try {
    entity = await client.getEntity(PARTITION, id);
  } catch (err) {
    if (err.statusCode === 404) return json(404, { ok: false, error: 'Project not found.' });
    throw err;
  }
  let drafts = [];
  try { drafts = JSON.parse(entity.draftsJson || '[]'); } catch (err) {}
  const now = new Date().toISOString();
  const set = new Set(openedEmails);
  drafts.forEach(d => {
    if (set.has(d.email) && !d.opened) {
      d.opened = true;
      d.openedAt = now;
    }
  });
  await client.updateEntity(
    { partitionKey: PARTITION, rowKey: id, draftsJson: JSON.stringify(drafts) },
    'Merge'
  );
  return json(200, { ok: true, opened: drafts.filter(d => d.opened).length });
}
