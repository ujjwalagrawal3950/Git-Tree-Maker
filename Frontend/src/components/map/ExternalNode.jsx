import { Handle, Position } from '@xyflow/react'

export default function ExternalNode({ data }) {
  const canonicalId = data.canonicalId || data.id
  const name = data.packageName || data.label || canonicalId
  const ecosystem = data.ecosystem || 'pkg'
  const version = data.versionRequirement || ''
  const selected = Boolean(data.selected)
  const dimmed = Boolean(data.dimmed)

  return (
    <div
      className={[
        'external-node',
        selected ? 'is-selected' : '',
        dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        border: '1px dashed var(--border-strong, #64748b)',
        borderRadius: '6px',
        background: 'var(--canvas-muted, #0f172a)',
        padding: '5px 10px',
        fontSize: '11px',
        fontFamily: 'var(--font-mono, monospace)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        color: 'var(--text-muted, #94a3b8)',
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
        title={`External package: ${name} (${ecosystem} ${version})`}
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
            background: 'rgba(148, 163, 184, 0.2)',
            color: 'var(--text-muted, #94a3b8)',
            fontWeight: 600,
          }}
        >
          {ecosystem}
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

