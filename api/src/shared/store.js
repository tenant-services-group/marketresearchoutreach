'use strict';
/**
 * Table Storage access for outreach projects.
 *
 * Requires one App Setting on the Static Web App:
 *   STORAGE_CONNECTION_STRING — connection string of any Azure Storage account
 *
 * The table is created on first use; no manual setup beyond the setting.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.PROJECTS_TABLE || 'OutreachProjects';
const PARTITION = 'project';

let client = null;
let tableReady = false;

function getClient() {
  if (!client) {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) {
      const err = new Error('STORAGE_CONNECTION_STRING is not configured on the Static Web App.');
      err.statusCode = 503;
      throw err;
    }
    client = TableClient.fromConnectionString(conn, TABLE_NAME);
  }
  return client;
}

async function ensureTable() {
  if (tableReady) return;
  try {
    await getClient().createTable();
  } catch (err) {
    // 409 TableAlreadyExists is the normal case after first run
    if (err.statusCode !== 409) throw err;
  }
  tableReady = true;
}

function newId() {
  // Reverse-chronological RowKey so lexical order = newest first
  const rev = (9999999999999 - Date.now()).toString().padStart(13, '0');
  return rev + '-' + Math.random().toString(36).slice(2, 8);
}

module.exports = { getClient, ensureTable, newId, PARTITION };
