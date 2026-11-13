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
import SymbolNode from './SymbolNode'
import ExternalNode from './ExternalNode'
import { applyGraphSelectionTones } from '../../lib/graphTransformer'
import { layoutGraphElements } from '../../lib/graphLayout'

const nodeTypes = {
  folder: FolderNode,
  file: FileNode,
  symbol: SymbolNode,
  external: ExternalNode,
}

const TONE_COLOR = {
  default: 'var(--edge, #64748b)',
  dim: 'var(--edge, #64748b)',
  incoming: 'var(--incoming, #22c55e)',
  outgoing: 'var(--outgoing, #3b82f6)',
}

function toFlowEdges(edges) {
  return edges.map((edge) => {
    const tone = edge.tone || 'default'
    const color = TONE_COLOR[tone] || TONE_COLOR.default
    const emphasized = tone === 'incoming' || tone === 'outgoing' || Boolean(edge.selected)
    const dimmed = tone === 'dim'

    const label =
      edge.label ||
      (edge.count > 1 ? String(edge.count) : edge.data?.edgeType !== 'depends_on' ? edge.data?.edgeType : undefined)

    return {
      ...edge,
      type: 'smoothstep',
      label,
      labelShowBg: Boolean(label),
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 2,
      labelBgStyle: {
        fill: 'var(--canvas, #0f172a)',
        stroke: 'var(--border, #334155)',
        strokeWidth: 1,
      },
      labelStyle: {
        fill: 'var(--text-muted, #94a3b8)',
        fontSize: 10,
        fontFamily: 'var(--font-mono, monospace)',
        opacity: dimmed ? 0.4 : 1,
      },
      style: {
        stroke: color,
        strokeWidth: emphasized ? 2.2 : 1.2,
        opacity: dimmed ? 0.2 : 1,
        cursor: 'pointer',
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 14,
        height: 14,
      },
    }
  })
}

export default function DependencyMap({
  repository,
  backendNodes,
  backendEdges,
  isTruncated,
  expandedFolder,
  selectedFileId,
  selectedNodeId,
  selectedEdgeId,
  onToggleFolder,
  onSelectFile,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}) {
  const isBackendMode = Boolean(backendNodes && backendNodes.length > 0)
  const effectiveSelectedNodeId = selectedNodeId || selectedFileId

  // Layout for backend nodes & edges
  const backendPositionedNodes = useMemo(() => {
    if (!isBackendMode) return []
    return layoutGraphElements(backendNodes, backendEdges || [])
  }, [isBackendMode, backendNodes, backendEdges])

  // Elements for mock repository
  const mockModel = useMemo(() => {
    if (isBackendMode || !repository) return { nodes: [], edges: [] }
    return buildElements(repository, expandedFolder, effectiveSelectedNodeId)
  }, [isBackendMode, repository, expandedFolder, effectiveSelectedNodeId])

  // Prepare final React Flow nodes
  const flowNodes = useMemo(() => {
    if (isBackendMode) {
      return backendPositionedNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          selected: node.id === effectiveSelectedNodeId,
          dimmed:
            effectiveSelectedNodeId &&
            node.id !== effectiveSelectedNodeId &&
            !(backendEdges || []).some(
              (e) =>
                (e.source === effectiveSelectedNodeId && e.target === node.id) ||
                (e.target === effectiveSelectedNodeId && e.source === node.id),
            ),
          onSelect: onSelectNode || onSelectFile,
        },
      }))
    }

    return mockModel.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...(node.type === 'folder'
          ? { onToggle: onToggleFolder }
          : { onSelect: onSelectFile }),
      },
    }))
  }, [
    isBackendMode,
    backendPositionedNodes,
    backendEdges,
    mockModel.nodes,
    effectiveSelectedNodeId,
    onSelectNode,
    onSelectFile,
    onToggleFolder,
  ])

  // Prepare final React Flow edges with selection tones
  const flowEdges = useMemo(() => {
    if (isBackendMode) {
      const edgesWithTones = applyGraphSelectionTones(
        backendEdges || [],
        effectiveSelectedNodeId,
        selectedEdgeId,
      )
      return toFlowEdges(edgesWithTones)
    }

    return toFlowEdges(mockModel.edges)
  }, [isBackendMode, backendEdges, effectiveSelectedNodeId, selectedEdgeId, mockModel.edges])

  const handleNodeClick = useCallback(
    (_event, node) => {
      if (node.type === 'folder' && onToggleFolder) {
        onToggleFolder(node.data.folderId)
      } else if (onSelectNode) {
        onSelectNode(node.id)
      } else if (onSelectFile) {
        onSelectFile(node.data.file?.id || node.id)
      }
    },
    [onToggleFolder, onSelectNode, onSelectFile],
  )

  const handleEdgeClick = useCallback(
    (_event, edge) => {
      if (onSelectEdge) {
        onSelectEdge(edge.id)
      }
    },
    [onSelectEdge],
  )

  return (
    <div className="map-canvas" style={{ position: 'relative', width: '100%', height: '100%' }}>
      {isTruncated && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 10,
            background: 'rgba(234, 88, 12, 0.9)',
            color: '#fff',
            padding: '6px 12px',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 500,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span>Bounded neighborhood: node limit reached (subgraph truncated)</span>
        </div>
      )}

      <ReactFlow
        key={isBackendMode ? `backend:${backendNodes.length}:${backendEdges?.length || 0}` : `${expandedFolder ?? 'collapsed'}:${effectiveSelectedNodeId ? 'detail' : 'full'}`}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={onClearSelection}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={true}
        minZoom={0.15}
        maxZoom={2.0}
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
