import { Handle, Position } from '@xyflow/react'
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
} from '../Icons'

export default function FolderNode({ data }) {
  const {
    folderId,
    label,
    path,
    depth = 0,
    fileCount,
    subfolderCount = 0,
    incoming,
    outgoing,
    internal = 0,
    expanded,
    selected,
    dimmed,
    isRoot,
    onToggle,
  } = data

  const isRootGroup = Boolean(isRoot || folderId === 'root')
  const displayLabel = label || (isRootGroup ? 'Root Files' : folderId)
  const depthClass = `folder-node--depth-${Math.min(depth, 3)}`
  const countTooltip =
    subfolderCount > 0
      ? `${subfolderCount} ${subfolderCount === 1 ? 'subfolder' : 'subfolders'} · ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
      : `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`

  return (
    <div
      className={[
        'folder-node',
        depthClass,
        isRootGroup ? 'is-root-group' : '',
        subfolderCount > 0 ? 'has-subfolders' : '',
        expanded ? 'is-expanded' : '',
        selected ? 'is-selected' : '',
        dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle
        id="target-left"
        type="target"
        position={Position.Left}
        className="map-handle"
        isConnectable={false}
        style={{ opacity: expanded ? 0 : 1, pointerEvents: 'none' }}
      />

      <button
        type="button"
        className="folder-node__header"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${displayLabel} folder`}
        title={path && path !== displayLabel ? path : displayLabel}
        onClick={(event) => {
          event.stopPropagation()
          if (typeof onToggle === 'function') {
            onToggle(folderId)
          }
        }}
      >
        <span className="folder-node__chevron">
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
        <span className="folder-node__icon">
          {isRootGroup ? <FileIcon /> : <FolderIcon />}
        </span>
        <span className="folder-node__name">{displayLabel}</span>
        {expanded && subfolderCount > 0 && (
          <span className="folder-node__subbadge" title={countTooltip}>
            {subfolderCount} {subfolderCount === 1 ? 'dir' : 'dirs'}
          </span>
        )}
        <span className="folder-node__count" title={countTooltip}>
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
          {internal > 0 && (
            <span
              className="folder-node__stat folder-node__stat--internal"
              title={`${internal} internal ${internal === 1 ? 'dependency' : 'dependencies'}`}
            >
              ⇄ {internal}
            </span>
          )}
          {subfolderCount > 0 && (
            <span
              className="folder-node__stat folder-node__stat--dirs"
              title={countTooltip}
            >
              {subfolderCount} {subfolderCount === 1 ? 'folder' : 'folders'}
            </span>
          )}
        </div>
      )}

      <Handle
        id="source-right"
        type="source"
        position={Position.Right}
        className="map-handle"
        isConnectable={false}
        style={{ opacity: expanded ? 0 : 1, pointerEvents: 'none' }}
      />
    </div>
  )
}
