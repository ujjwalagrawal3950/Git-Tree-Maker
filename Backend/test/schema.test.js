const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const schema = fs.readFileSync(
  path.resolve(__dirname, '..', 'schema.sql'),
  'utf8',
)

test('schema does not contain a permissive anon policy', () => {
  assert.doesNotMatch(schema, /USING\s*\(\s*true\s*\)/i)
  assert.doesNotMatch(schema, /WITH CHECK\s*\(\s*true\s*\)/i)
  assert.doesNotMatch(schema, /CREATE POLICY[\s\S]*?TO\s+anon\b/i)
})

test('RLS is enabled on every protected table', () => {
  const tables = [
    'users',
    'organizations',
    'organization_members',
    'webhook_events',
    'deleted_user_tombstones',
    'deleted_organization_tombstones',
    'deleted_organization_membership_tombstones',
  ]

  for (const table of tables) {
    const pattern = new RegExp(
      `ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`,
      'i',
    )
    assert.match(schema, pattern, `${table} must have RLS enabled`)
  }
})

test('user deletion cascades to organization memberships', () => {
  assert.match(schema, /REFERENCES public\.users\(id\)\s+ON DELETE CASCADE/i)
  assert.match(schema, /CREATE OR REPLACE FUNCTION public\.delete_user_cascade/i)
  assert.match(schema, /DELETE FROM public\.users WHERE id = p_user_id/i)
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS public\.deleted_organization_tombstones/i,
  )
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS public\.deleted_organization_membership_tombstones/i,
  )
})

test('the webhook ledger and ordering functions exist', () => {
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS public\.webhook_events/i,
  )
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION public\.claim_webhook_event/i,
  )
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION public\.upsert_user_from_source/i,
  )
  // Reclaiming a stale processing event must renew its lease.
  assert.match(schema, /received_at = NOW\(\)/i)
})
