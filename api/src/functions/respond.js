'use strict';
/**
 * /api/respond — process broker reply emails into a Monday board.
 * /api/config  — public config the frontend needs (Entra sign-in ids).
 *
 *   GET  /api/config → { ok, entra: { clientId, tenantId } }
 *
 *   POST /api/respond → body:
 *     { target: {type:'existing', boardId} | {type:'new', workspaceId, name},
 *       replies: [{ fromEmail, fromName, receivedAt, subject, bodyText, addresses:[..] }] }
 *     → { ok, boardId, boardUrl, updated, createdItems, unmatched:[..],
 *         results:[{address, notes, squareFootage, flyerLink, fromEmail, receivedAt}], failed:[..] }
 *
 * For each reply, Claude extracts { notes, squareFootage, flyerLinks } from the body.
 * Board updates per matched address:
 *   Email Status → "*Email Received", Elimination Reason → "Pending",
 *   Email Received Date → reply date, Notes / Square footage / Flyer Link → extracted.
 * Data Status and Affirmatives are intentionally left for manual review.
 *
 * App Settings: ANTHROPIC_API_KEY (required), CLAUDE_MODEL (optional,
 * default claude-haiku-4-5-20251001), MONDAY_API_TOKEN, ENTRA_CLIENT_ID, ENTRA_TENANT_ID.
 */

const { app } = require('@azure/functions');
const { createBoard, ensureColumns, listItems, createItem, updateItem } = require('../shared/monday-client');

const MAX_REPLIES = 50;
const MAX_BODY = 12000;

const clean = (v, max) =>
  String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const debugInfo = (err) =>
  process.env.DEBUG_RESPONSE === 'true' ? String(err && err.message).slice(0, 600) : undefined;

app.http('config', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'config',
  handler: async () => json(200, {
    ok: true,
    entra: {
      clientId: process.env.ENTRA_CLIENT_ID || '',
      tenantId: process.env.ENTRA_TENANT_ID || '',
    },
  }),
});

app.http('respond', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'respond',
  handler: async (request, context) => {
    try {
      return await processReplies(request, context);
    } catch (err) {
      context.error('respond API error:', err.message);
      const status = err.statusCode === 503 ? 503 : 500;
      return json(status, {
        ok: false,
        error: status === 503 ? err.message : 'Response processing failed: ' + String(err.message).slice(0, 300),
        debug: debugInfo(err),
      });
    }
  },
});

// ---------- Claude extraction ----------

async function extractWithClaude(reply) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY is not configured on the Static Web App.');
    err.statusCode = 503;
    throw err;
  }
  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const prompt =
    'You are processing a commercial real estate broker\'s email reply to a market-research inquiry.\n' +
    'Reply subject: ' + reply.subject + '\n' +
    'Reply body:\n---\n' + reply.bodyText.slice(0, MAX_BODY) + '\n---\n\n' +
    'Extract the property details. Respond with ONLY a JSON object, no markdown fences, no preamble:\n' +
    '{"notes": "<concise summary of the property details and any availability/terms mentioned; professional tone; exclude square footage figures (captured separately); exclude greetings and pleasantries; empty string if the reply contains no property details>",\n' +
    ' "squareFootage": "<the available square footage exactly as stated, e.g. \\"6,800-12,500 SF\\"; empty string if not mentioned>",\n' +
    ' "flyerLinks": ["<any URLs in the reply that point to flyers, brochures, listings, or marketing material>"]}';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Claude API: ' + (data.error.message || JSON.stringify(data.error)).slice(0, 200));
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return {
      notes: clean(parsed.notes, 2000),
      squareFootage: clean(parsed.squareFootage, 200),
      flyerLinks: (Array.isArray(parsed.flyerLinks) ? parsed.flyerLinks : [])
        .map(u => clean(u, 500)).filter(u => /^https?:\/\//i.test(u)).slice(0, 5),
    };
  } catch (err) {
    // Extraction is best-effort: fall back to the raw reply as the note
    return { notes: clean(reply.bodyText, 2000), squareFootage: '', flyerLinks: [] };
  }
}

// ---------- Main flow ----------

async function processReplies(request, context) {
  let body = {};
  try { body = await request.json(); } catch (err) {}

  const target = body.target || {};
  const replies = (Array.isArray(body.replies) ? body.replies.slice(0, MAX_REPLIES) : [])
    .map(r => ({
      fromEmail: clean(r.fromEmail, 254).toLowerCase(),
      fromName: clean(r.fromName, 120),
      receivedAt: clean(r.receivedAt, 40),
      subject: clean(r.subject, 500),
      bodyText: String(r.bodyText == null ? '' : r.bodyText).slice(0, MAX_BODY),
      addresses: (Array.isArray(r.addresses) ? r.addresses : []).map(a => clean(a, 255)).filter(Boolean),
    }))
    .filter(r => r.fromEmail && r.bodyText);
  if (!replies.length) return json(400, { ok: false, error: 'No replies were provided.' });

  // Resolve target board
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

  // Existing items on the board, matched by name (= property address)
  const items = await listItems(boardId);
  const itemByName = {};
  items.forEach(it => { itemByName[it.name.trim().toLowerCase()] = it.id; });

  let updated = 0, createdItems = 0;
  const results = [];
  const unmatched = [];
  const failed = [];

  for (const reply of replies) {
    let extract;
    try {
      extract = await extractWithClaude(reply);
    } catch (err) {
      if (err.statusCode === 503) throw err;
      failed.push({ fromEmail: reply.fromEmail, error: String(err.message).slice(0, 200) });
      continue;
    }
    const receivedDate = (reply.receivedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const cv = {};
    cv[colId.emailStatus]       = { label: '*Email Received' };
    cv[colId.eliminationReason] = { label: 'Pending' };
    cv[colId.emailReceivedDate] = { date: receivedDate };
    if (extract.notes)         cv[colId.notes] = { text: extract.notes };
    if (extract.squareFootage) cv[colId.squareFootage] = extract.squareFootage;
    if (extract.flyerLinks.length) cv[colId.flyerLink] = { url: extract.flyerLinks[0], text: 'Flyer' };

    const addresses = reply.addresses.length ? reply.addresses : ['(no address matched)'];
    for (const address of addresses) {
      const rowResult = {
        address,
        fromEmail: reply.fromEmail,
        receivedAt: receivedDate,
        notes: extract.notes,
        squareFootage: extract.squareFootage,
        flyerLink: extract.flyerLinks[0] || '',
      };
      if (address === '(no address matched)') {
        unmatched.push({ fromEmail: reply.fromEmail, subject: reply.subject });
        results.push(rowResult);
        continue;
      }
      try {
        const existing = itemByName[address.trim().toLowerCase()];
        if (existing) {
          await updateItem(boardId, existing, cv);
          updated++;
        } else {
          const createCv = Object.assign({}, cv);
          if (reply.fromEmail) createCv[colId.contactEmail] = { email: reply.fromEmail, text: reply.fromEmail };
          const newId = await createItem(boardId, address, createCv);
          itemByName[address.trim().toLowerCase()] = newId;
          createdItems++;
        }
        results.push(rowResult);
      } catch (err) {
        failed.push({ address, error: String(err.message).slice(0, 200) });
        context.error('board update failed:', err.message);
      }
    }
    await new Promise(res => setTimeout(res, 200));
  }

  return json(200, { ok: true, boardId, boardUrl, updated, createdItems, unmatched, results, failed });
}
