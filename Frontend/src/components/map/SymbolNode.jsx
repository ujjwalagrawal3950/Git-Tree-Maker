import { Handle, Position } from '@xyflow/react'

export default function SymbolNode({ data }) {
  const canonicalId = data.canonicalId || data.id
  const name = data.name || data.label || canonicalId
  const kind = data.kind || 'symbol'
  const qualifiedName = data.qualifiedName || name
  const selected = Boolean(data.selected)
  const dimmed = Boolean(data.dimmed)

  return (
    <div
      className={[
        'symbol-node',
        selected ? 'is-selected' : '',
        dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        border: '1px solid var(--border)',
        borderRadius: '6px',
        background: 'var(--canvas-subtle, #1e293b)',
        padding: '6px 12px',
        fontSize: '12px',
        fontFamily: 'var(--font-mono, monospace)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        color: 'var(--text, #f8fafc)',
        opacity: dimmed ? 0.35 : 1,
        boxShadow: selected ? '0 0 0 2px var(--brand, #38bdf8)' : 'none',
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="map-handle"
        isConnectable={false}
      />

      <button
        type="button"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          cursor: 'pointer',
          color: 'inherit',
          width: '100%',
        }}
        title={`${qualifiedName} (${kind})`}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          if (typeof data.onSelect === 'function') {
            data.onSelect(canonicalId)
          }
        }}
      >
        <span
          style={{
            fontSize: '9px',
            textTransform: 'uppercase',
            padding: '2px 4px',
            borderRadius: '3px',
            background: 'var(--brand-muted, rgba(56, 189, 248, 0.2))',
            color: 'var(--brand, #38bdf8)',
            fontWeight: 600,
          }}
        >
          {kind}
        </span>
        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
      </button>

      <Handle
        type="source"
        position={Position.Right}
        className="map-handle"
        isConnectable={false}
      />
    </div>
  )
}

