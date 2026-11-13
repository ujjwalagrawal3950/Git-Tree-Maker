import { Handle, Position } from '@xyflow/react'
import { getKindMeta } from '../../lib/kinds'

export default function FileNode({ data }) {
  const { file, selected, dimmed, onSelect } = data
  const meta = getKindMeta(file.kind)

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
        type="target"
        position={Position.Left}
        className="map-handle"
        isConnectable={false}
      />

      <button
        type="button"
        className="file-node__button"
        title={file.path}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          onSelect(file.id)
        }}
      >
        <span className="file-node__dot" />
        <span className="file-node__name">{file.name}</span>
        <span className="file-node__kind">{meta.label}</span>
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
