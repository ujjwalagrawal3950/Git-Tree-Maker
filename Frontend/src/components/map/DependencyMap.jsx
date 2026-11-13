import { useCallback, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
} from '@xyflow/react'
import { buildElements } from './buildElements'
import FileNode from './FileNode'
import FolderNode from './FolderNode'

const nodeTypes = { folder: FolderNode, file: FileNode }

const TONE_COLOR = {
  default: 'var(--edge)',
  dim: 'var(--edge)',
  incoming: 'var(--incoming)',
  outgoing: 'var(--outgoing)',
}

function toFlowNodes(nodes, onToggleFolder, onSelectFile) {
  return nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      ...(node.type === 'folder'
        ? { onToggle: onToggleFolder }
        : { onSelect: onSelectFile }),
    },
  }))
}

function toFlowEdges(edges) {
  return edges.map((edge) => {
    const color = TONE_COLOR[edge.tone]
    const emphasized = edge.tone === 'incoming' || edge.tone === 'outgoing'
    const dimmed = edge.tone === 'dim'

    return {
      ...edge,
      type: 'smoothstep',
      label: edge.count > 1 ? String(edge.count) : undefined,
      labelShowBg: true,
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 2,
      labelBgStyle: {
        fill: 'var(--canvas)',
        stroke: 'var(--border)',
        strokeWidth: 1,
      },
      labelStyle: {
        fill: 'var(--text-muted)',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        opacity: dimmed ? 0.4 : 1,
      },
      style: {
        stroke: color,
        strokeWidth: emphasized ? 1.8 : 1.2,
        opacity: dimmed ? 0.16 : 1,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 14,
        height: 14,
      },
      focusable: false,
    }
  })
}

export default function DependencyMap({
  repository,
  expandedFolder,
  selectedFileId,
  onToggleFolder,
  onSelectFile,
  onClearSelection,
}) {
  const model = useMemo(
    () => buildElements(repository, expandedFolder, selectedFileId),
    [repository, expandedFolder, selectedFileId],
  )

  const flowNodes = useMemo(
    () => toFlowNodes(model.nodes, onToggleFolder, onSelectFile),
    [model.nodes, onToggleFolder, onSelectFile],
  )
  const flowEdges = useMemo(() => toFlowEdges(model.edges), [model.edges])

  const handleNodeClick = useCallback(
    (_event, node) => {
      if (node.type === 'folder') onToggleFolder(node.data.folderId)
      if (node.type === 'file') onSelectFile(node.data.file.id)
    },
    [onToggleFolder, onSelectFile],
  )

  return (
    <div className="map-canvas">
      <ReactFlow
        key={`${expandedFolder ?? 'collapsed'}:${selectedFileId ? 'detail' : 'full'}`}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={onClearSelection}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        minZoom={0.2}
        maxZoom={1.8}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="var(--rf-grid)"
        />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  )
}
