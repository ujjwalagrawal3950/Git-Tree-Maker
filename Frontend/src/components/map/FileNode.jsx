import { Handle, Position } from '@xyflow/react'
import { getKindMeta } from '../../lib/kinds'

export default function FileNode({ data }) {
  const file = data.file || data.rawNode || data
  const canonicalId = data.canonicalId || file.id
  const name = data.label || file.name || (data.path ? data.path.split('/').pop() : canonicalId)
  const path = data.path || file.path || canonicalId
  const kind = data.kind || data.language || file.kind || 'file'
  const meta = getKindMeta(kind)

  const selected = Boolean(data.selected)
  const dimmed = Boolean(data.dimmed)

  return (
    <div
      className={[
        'file-node',
        selected ? 'is-selected' : '',
        dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--kind': meta.color }}
    >
      <Handle
        id="target-left"
        type="target"
        position={Position.Left}
        className="map-handle"
        isConnectable={false}
      />
      <Handle
        id="target-right"
        type="target"
        position={Position.Right}
        className="map-handle"
        isConnectable={false}
      />

      <button
        type="button"
        className="file-node__button"
        title={path}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          if (typeof data.onSelect === 'function') {
            data.onSelect(canonicalId)
          }
        }}
      >
        <span className="file-node__dot" />
        <span className="file-node__name">{name}</span>
        <span className="file-node__kind">{meta.label}</span>
      </button>

      <Handle
        id="source-right"
        type="source"
        position={Position.Right}
        className="map-handle"
        isConnectable={false}
      />
    </div>
  )
}
