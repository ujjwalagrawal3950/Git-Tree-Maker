import { Handle, Position } from '@xyflow/react'
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
} from '../Icons'

export default function FolderNode({ data }) {
  const {
    folderId,
    label,
    fileCount,
    incoming,
    outgoing,
    expanded,
    selected,
    dimmed,
    onToggle,
  } = data

  return (
    <div
      className={[
        'folder-node',
        expanded ? 'is-expanded' : '',
        selected ? 'is-selected' : '',
        dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="map-handle"
        isConnectable={false}
      />

      <button
        type="button"
        className="folder-node__header"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} folder`}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(folderId)
        }}
      >
        <span className="folder-node__chevron">
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
        <span className="folder-node__icon">
          <FolderIcon />
        </span>
        <span className="folder-node__name">{label}</span>
        <span
          className="folder-node__count"
          title={`${fileCount} ${fileCount === 1 ? 'file' : 'files'}`}
        >
          {fileCount}
        </span>
      </button>

      {!expanded && (
        <div className="folder-node__meta">
          <span
            className="folder-node__stat folder-node__stat--in"
            title={`${incoming} incoming ${incoming === 1 ? 'edge' : 'edges'}`}
          >
            <ArrowDownLeftIcon />
            {incoming}
          </span>
          <span
            className="folder-node__stat folder-node__stat--out"
            title={`${outgoing} outgoing ${outgoing === 1 ? 'edge' : 'edges'}`}
          >
            <ArrowUpRightIcon />
            {outgoing}
          </span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="map-handle"
        isConnectable={false}
      />
    </div>
  )
}
