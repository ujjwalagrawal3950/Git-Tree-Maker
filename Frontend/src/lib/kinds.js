export const KIND_META = {
  entry: { label: 'Entry', color: 'var(--kind-entry)' },
  component: { label: 'Component', color: 'var(--kind-component)' },
  hook: { label: 'Hook', color: 'var(--kind-hook)' },
  utility: { label: 'Utility', color: 'var(--kind-utility)' },
  style: { label: 'Style', color: 'var(--kind-style)' },
  config: { label: 'Config', color: 'var(--kind-config)' },
  test: { label: 'Test', color: 'var(--kind-test)' },
  doc: { label: 'Doc', color: 'var(--kind-doc)' },
  source: { label: 'Source', color: 'var(--kind-source)' },
  asset: { label: 'Asset', color: 'var(--kind-asset)' },
  file: { label: 'File', color: 'var(--kind-file)' },
  function: { label: 'Function', color: 'var(--kind-function)' },
  constant: { label: 'Constant', color: 'var(--kind-constant)' },
  class: { label: 'Class', color: 'var(--kind-class)' },
  variable: { label: 'Variable', color: 'var(--kind-variable)' },
  symbol: { label: 'Symbol', color: 'var(--kind-symbol)' },
}

export const KIND_ORDER = [
  'entry',
  'component',
  'hook',
  'utility',
  'style',
  'config',
  'test',
  'doc',
  'source',
  'function',
  'constant',
  'class',
]

export function getKindMeta(kind) {
  const normalized = typeof kind === 'string' ? kind.toLowerCase() : ''
  return KIND_META[normalized] ?? { label: kind || 'File', color: 'var(--text-faint)' }
}
