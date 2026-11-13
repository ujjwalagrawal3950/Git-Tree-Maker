export const KIND_META = {
  entry: { label: 'Entry', color: 'var(--kind-entry)' },
  component: { label: 'Component', color: 'var(--kind-component)' },
  hook: { label: 'Hook', color: 'var(--kind-hook)' },
  utility: { label: 'Utility', color: 'var(--kind-utility)' },
  style: { label: 'Style', color: 'var(--kind-style)' },
  config: { label: 'Config', color: 'var(--kind-config)' },
  test: { label: 'Test', color: 'var(--kind-test)' },
}

export const KIND_ORDER = [
  'entry',
  'component',
  'hook',
  'utility',
  'style',
  'config',
  'test',
]

export function getKindMeta(kind) {
  return KIND_META[kind] ?? { label: kind, color: 'var(--text-faint)' }
}
