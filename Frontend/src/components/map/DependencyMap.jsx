import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import { computeGraphGeometry, decorateGraphElements } from './buildElements'
import FileNode from './FileNode'
import FolderNode from './FolderNode'
import SymbolNode from './SymbolNode'
import ExternalNode from './ExternalNode'
import SearchBar from './SearchBar'
import Breadcrumbs from './Breadcrumbs'

function ViewportFocusHandler({ focusTargetId, onFocusDone }) {
  const { fitView } = useReactFlow()

  useEffect(() => {
    if (!focusTargetId) return
    const timer = setTimeout(() => {
      try {
        fitView({
          nodes: [{ id: focusTargetId }],
          duration: 450,
          padding: 0.35,
          maxZoom: 1.25,
        })
      } catch {
        // Safe fallback if node not currently in flow layout
      }
      if (onFocusDone) onFocusDone()
    }, 60)
    return () => clearTimeout(timer)
  }, [focusTargetId, fitView, onFocusDone])

  return null
}

const nodeTypes = {
  folder: FolderNode,
  file: FileNode,
  symbol: SymbolNode,
  external: ExternalNode,
}

const TONE_COLOR = {
  default: '#475569',
  dim: '#334155',
  incoming: '#22c55e',
  outgoing: '#38bdf8',
}

function toFlowEdges(edges, selectedEdgeId) {
  return edges.map((edge) => {
    const tone = edge.tone || 'default'
    const isSelected = Boolean(edge.selected || (selectedEdgeId && edge.id === selectedEdgeId))
    const isSubsystemEdge = Boolean(
      edge.isCrossSubsystem ||
      (edge.source?.startsWith('folder:') && edge.target?.startsWith('folder:')),
    )
    const isAggregated = Boolean(edge.isAggregated || edge.count > 1)
    const isHttpOnly = Boolean(
      edge.type === 'http_request' ||
      edge.data?.edgeType === 'http_request' ||
      edge.data?.isHttpRequest ||
      (edge.underlyingEdges &&
        edge.underlyingEdges.length > 0 &&
        edge.underlyingEdges.every((e) => e.type === 'http_request'))
    )
    const hasHttpInAggregate = Boolean(
      edge.hasHttpRequest ||
      (edge.underlyingEdges && edge.underlyingEdges.some((e) => e.type === 'http_request'))
    )

    // Base color
    let color = TONE_COLOR[tone] || '#64748b'
    if (isSelected) {
      color = '#38bdf8'
    } else if (isHttpOnly) {
      color = '#06b6d4' // vibrant cyan accent for HTTP API requests
    } else if (hasHttpInAggregate && tone === 'default') {
      color = '#a855f7' // distinctive vivid violet for mixed communication channels
    } else if (isSubsystemEdge && tone === 'default') {
      color = '#6366f1' // distinctive indigo accent for inter-subsystem data flow
    } else if (tone === 'default') {
      color = 'rgba(148, 163, 184, 0.45)' // clean translucent slate for single code edges
    }

    const emphasized = tone === 'incoming' || tone === 'outgoing' || isSelected
    const dimmed = tone === 'dim' && !isSelected

    // Dynamic stroke width based on dependency volume
    let strokeWidth = 1.3
    if (isSubsystemEdge) {
      strokeWidth = Math.min(4.0, 2.0 + Math.log2(edge.count || 1) * 0.8)
    } else if (isAggregated) {
      strokeWidth = Math.min(3.2, 1.6 + Math.log2(edge.count || 1) * 0.5)
    }
    if (emphasized) strokeWidth += 1.0

    // Minimalist canvas labels:
    // Only show text pills on:
    // 1. Aggregated edges (count > 1, e.g. "imports (4)", "HTTP (12)", "connections (7)")
    // 2. HTTP edges (where route method/path or "HTTP" is informative)
    // 3. User interaction (when an edge is selected or emphasized)
    // 4. Non-standard relationship semantics if present (e.g. "renders", "calls")
    // Never clutter the canvas with walls of redundant single "imports" pills.
    const isSingleDefaultImport =
      !isAggregated &&
      !isHttpOnly &&
      (edge.count || 1) <= 1 &&
      (edge.baseLabel === 'imports' || edge.type === 'imports' || !edge.baseLabel)

    const showLabel =
      isSelected ||
      emphasized ||
      isHttpOnly ||
      (isAggregated && (edge.count || 1) > 1) ||
      (!isSingleDefaultImport && edge.baseLabel && edge.baseLabel !== 'imports')

    const label = showLabel
      ? edge.label ||
        (edge.count > 1
          ? `${edge.baseLabel || 'imports'} (${edge.count})`
          : edge.baseLabel || 'imports')
      : undefined

    const strokeDasharray = isHttpOnly
      ? '5, 4'
      : hasHttpInAggregate && isAggregated
        ? '7, 3, 2, 3'
        : undefined

    // Edge routing:
    // - Intra-folder file-to-file dependencies use smoothstep rounded bracket arc on the right
    // - Inter-folder / inter-node dependencies use fluid, organic bezier curves
    const isIntraFolder = Boolean(
      !edge.isCrossDirectory &&
      edge.source?.startsWith('file:') &&
      edge.target?.startsWith('file:')
    )

    const edgeType = isIntraFolder ? 'smoothstep' : 'bezier'
    const targetHandle = isIntraFolder ? 'target-right' : 'target-left'
    const sourceHandle = 'source-right'

    return {
      ...edge,
      type: edgeType,
      targetHandle,
      sourceHandle,
      pathOptions: isIntraFolder ? { borderRadius: 8 } : { curvature: 0.28 },
      zIndex: isSelected ? 35 : isHttpOnly ? 30 : isSubsystemEdge ? 25 : emphasized ? 20 : 15,
      label,
      labelShowBg: Boolean(label),
      labelBgPadding: [6, 2],
      labelBgBorderRadius: 9999,
      labelBgStyle: {
        fill: '#090e17',
        stroke: emphasized
          ? color
          : isHttpOnly
            ? '#0891b2'
            : isSubsystemEdge
              ? '#4338ca'
              : 'rgba(255, 255, 255, 0.1)',
        strokeWidth: emphasized ? 1.5 : 1.0,
        opacity: dimmed ? 0.25 : 0.95,
      },
      labelStyle: {
        fill: emphasized
          ? '#38bdf8'
          : isHttpOnly
            ? '#67e8f9'
            : isSubsystemEdge
              ? '#c7d2fe'
              : '#cbd5e1',
        fontSize: isSubsystemEdge || isHttpOnly ? 10 : 9,
        fontWeight: 600,
        fontFamily: 'var(--font-mono, monospace)',
        opacity: dimmed ? 0.2 : 1,
      },
      style: {
        stroke: color,
        strokeWidth,
        strokeDasharray,
        opacity: dimmed ? 0.15 : 0.9,
        cursor: 'pointer',
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: isSubsystemEdge || isHttpOnly ? 10 : 8,
        height: isSubsystemEdge || isHttpOnly ? 10 : 8,
      },
    }
  })
}

export default function DependencyMap({
  repository,
  manifestRepository,
  backendNodes,
  backendEdges,
  isTruncated,
  expandedFolder,
  expandedFolders,
  selectedFileId,
  selectedNodeId,
  selectedEdgeId,
  viewMode = 'detailed',
  onToggleViewMode,
  crossDirectoryOnly = false,
  onToggleCrossDirectory,
  relationshipFilter: controlledRelationshipFilter,
  onSelectRelationshipFilter,
  onToggleFolder,
  onExpandNextLevel,
  onExpandAll,
  onCollapseAll,
  onSelectFile,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onNavigateToItem,
}) {
  const [internalRelationshipFilter, setInternalRelationshipFilter] = useState('all')
  const relationshipFilter =
    controlledRelationshipFilter !== undefined
      ? controlledRelationshipFilter
      : internalRelationshipFilter

  const handleSelectRelationshipFilter = (filter) => {
    if (typeof onSelectRelationshipFilter === 'function') {
      onSelectRelationshipFilter(filter)
    } else {
      setInternalRelationshipFilter(filter)
    }
  }

  const [focusTargetId, setFocusTargetId] = useState(null)
  const isBackendMode = Boolean(
    manifestRepository || (backendNodes && backendNodes.length > 0),
  )
  const effectiveSelectedNodeId = selectedNodeId || selectedFileId
  const effectiveExpanded = expandedFolders !== undefined ? expandedFolders : expandedFolder

  // Derive repository data structure: prioritize manifestRepository, then fallback to backendNodes or repository
  const activeRepository = useMemo(() => {
    if (manifestRepository) {
      return manifestRepository
    }
    if (backendNodes && backendNodes.length > 0) {
      const fileNodes = backendNodes.filter((n) => n.type !== 'symbol')
      const symbolNodes = backendNodes.filter((n) => n.type === 'symbol')

      // Group symbols by file path
      const symbolsByPath = new Map()
      for (const sym of symbolNodes) {
        const rawPath = sym.data?.path || sym.path
        if (rawPath) {
          if (!symbolsByPath.has(rawPath)) symbolsByPath.set(rawPath, [])
          symbolsByPath.get(rawPath).push({
            id: sym.id,
            name: sym.data?.label || sym.data?.name || sym.name || sym.id.split('#').pop(),
            kind: sym.data?.kind || sym.kind || 'symbol',
            path: rawPath,
          })
        }
      }

      return {
        files: fileNodes.map((n) => {
          const filePath = n.data?.path || n.path || n.id
          return {
            id: n.id,
            path: filePath,
            name:
              n.data?.label ||
              n.label ||
              (filePath ? filePath.split('/').pop() : n.id),
            folder: n.data?.folder,
            kind: n.data?.kind || n.type || 'file',
            symbols: symbolsByPath.get(filePath) || [],
            raw: n,
          }
        }),
        edges: (backendEdges || []).map((e) => ({
          source: e.source,
          target: e.target,
          raw: e,
        })),
      }
    }
    return repository
  }, [manifestRepository, backendNodes, backendEdges, repository])

  // 1. Compute geometry (Dagre layout) strictly when repository or expandedFolders change
  const geometryModel = useMemo(() => {
    if (!activeRepository) {
      return {
        nodes: [],
        edges: [],
        nodeParentMap: new Map(),
        fileMap: new Map(),
        expandedFolders: effectiveExpanded,
      }
    }
    return computeGraphGeometry(activeRepository, effectiveExpanded, {
      crossDirectoryOnly,
      relationshipFilter,
    })
  }, [activeRepository, effectiveExpanded, crossDirectoryOnly, relationshipFilter])

  // 2. Decorate graph elements (O(V+E) selection/dimming/tones) without invoking Dagre
  const decoratedModel = useMemo(() => {
    return decorateGraphElements(
      geometryModel,
      effectiveSelectedNodeId,
      selectedEdgeId,
    )
  }, [geometryModel, effectiveSelectedNodeId, selectedEdgeId])

  // Invalidate stale edge selection when edge disappears on folder expansion (Safeguard 7)
  useEffect(() => {
    if (!selectedEdgeId) return
    const edgeStillExists = decoratedModel.edges.some((e) => e.id === selectedEdgeId)
    if (!edgeStillExists) {
      if (onSelectEdge) {
        onSelectEdge(null, null)
      }
    }
  }, [decoratedModel.edges, selectedEdgeId, onSelectEdge])

  // 3. Wire event handlers to nodes
  const flowNodes = useMemo(() => {
    return decoratedModel.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...(node.type === 'folder'
          ? { onToggle: onToggleFolder }
          : { onSelect: onSelectNode || onSelectFile }),
      },
    }))
  }, [decoratedModel.nodes, onToggleFolder, onSelectNode, onSelectFile])

  // 4. Style edges with directional arrows and aggregated count badges
  const flowEdges = useMemo(() => {
    return toFlowEdges(decoratedModel.edges, selectedEdgeId)
  }, [decoratedModel.edges, selectedEdgeId])

  const handleNodeClick = useCallback(
    (_event, node) => {
      if (node.type === 'folder' && onToggleFolder) {
        onToggleFolder(node.data.folderId)
      } else if (onSelectNode) {
        onSelectNode(node.data?.canonicalId || node.id)
      } else if (onSelectFile) {
        onSelectFile(node.data?.canonicalId || node.id)
      }
    },
    [onToggleFolder, onSelectNode, onSelectFile],
  )

  const handleEdgeClick = useCallback(
    (_event, edge) => {
      if (onSelectEdge) {
        onSelectEdge(edge.id, edge)
      }
    },
    [onSelectEdge],
  )

  const handleNavigateToItemInternal = useCallback(
    (item) => {
      if (onNavigateToItem) {
        onNavigateToItem(item)
      } else if (item.type === 'folder') {
        if (onToggleFolder) onToggleFolder(item.id)
      } else {
        const targetId = item.fileId || item.id
        if (onSelectNode) onSelectNode(targetId)
        else if (onSelectFile) onSelectFile(targetId)
      }

      const targetFlowId =
        item.type === 'folder'
          ? `folder:${item.id}`
          : `file:${item.fileId || item.id}`
      setFocusTargetId(targetFlowId)
    },
    [onNavigateToItem, onToggleFolder, onSelectNode, onSelectFile],
  )

  const handleNavigateCrumb = useCallback(
    (crumb) => {
      if (crumb.type === 'repo') {
        if (onCollapseAll) onCollapseAll()
        if (onClearSelection) onClearSelection()
        setFocusTargetId(null)
      } else if (crumb.type === 'folder') {
        if (onToggleFolder) onToggleFolder(crumb.targetId)
        setFocusTargetId(`folder:${crumb.targetId}`)
      } else if (crumb.type === 'file') {
        if (onSelectNode) onSelectNode(crumb.targetId)
        else if (onSelectFile) onSelectFile(crumb.targetId)
        setFocusTargetId(`file:${crumb.targetId}`)
      }
    },
    [onCollapseAll, onClearSelection, onToggleFolder, onSelectNode, onSelectFile],
  )

  return (
    <div
      className="map-canvas"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: '#070b12',
      }}
    >
      {/* Floating Architecture & Navigation Bar */}
      <div className="canvas-navigation-bar">
        <div className="canvas-toolbar-row">
          <SearchBar
            repository={activeRepository}
            onNavigateToItem={handleNavigateToItemInternal}
          />

          {/* Architecture Overview / Detailed Map Mode Switcher */}
          {onToggleViewMode && (
            <div
              style={{
                display: 'inline-flex',
                background: '#090e17',
                border: '1px solid #334155',
                borderRadius: '5px',
                padding: '2px',
                gap: '2px',
              }}
            >
              <button
                type="button"
                onClick={() => onToggleViewMode('architecture')}
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: '3px',
                  border: 'none',
                  background: viewMode === 'architecture' ? '#1e293b' : 'transparent',
                  color: viewMode === 'architecture' ? '#38bdf8' : '#94a3b8',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                title="Architectural Overview: view top-level subsystems and macro boundaries"
              >
                <span>🏛 Overview</span>
              </button>
              <button
                type="button"
                onClick={() => onToggleViewMode('detailed')}
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: '3px',
                  border: 'none',
                  background: viewMode === 'detailed' ? '#1e293b' : 'transparent',
                  color: viewMode === 'detailed' ? '#38bdf8' : '#94a3b8',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                title="Detailed Map: explore nested directories, files, and symbols"
              >
                <span>📄 Detailed</span>
              </button>
            </div>
          )}

          {/* Cross-Directory Only Filter Toggle */}
          {onToggleCrossDirectory && (
            <button
              type="button"
              onClick={onToggleCrossDirectory}
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '4px 9px',
                borderRadius: '4px',
                background: crossDirectoryOnly ? 'rgba(56, 189, 248, 0.15)' : '#1e293b',
                color: crossDirectoryOnly ? '#38bdf8' : '#94a3b8',
                border: `1px solid ${crossDirectoryOnly ? '#0284c7' : '#334155'}`,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
              }}
              title={
                crossDirectoryOnly
                  ? 'Cross-Directory Only filter ACTIVE: showing only edges across directory boundaries (click to show all edges)'
                  : 'Filter to Cross-Directory dependencies only (hides intra-directory dependencies)'
              }
            >
              <span>⚡ Cross-Directory</span>
              {crossDirectoryOnly && (
                <span
                  style={{
                    fontSize: '9px',
                    background: '#0284c7',
                    color: '#fff',
                    padding: '1px 4px',
                    borderRadius: '3px',
                    fontWeight: 700,
                  }}
                >
                  ON
                </span>
              )}
            </button>
          )}

          {/* Relationship Type Filter (Stage 5) */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '1px',
              gap: '1px',
            }}
            title="Filter relationships by category (Code vs HTTP API)"
          >
            <button
              type="button"
              onClick={() => handleSelectRelationshipFilter('all')}
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '3px 7px',
                borderRadius: '3px',
                border: 'none',
                background: relationshipFilter === 'all' ? '#0f172a' : 'transparent',
                color: relationshipFilter === 'all' ? '#38bdf8' : '#94a3b8',
                cursor: 'pointer',
              }}
              title="Show all dependency relationships"
            >
              All
            </button>
            <button
              type="button"
              onClick={() => handleSelectRelationshipFilter('code')}
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '3px 7px',
                borderRadius: '3px',
                border: 'none',
                background: relationshipFilter === 'code' ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
                color: relationshipFilter === 'code' ? '#38bdf8' : '#94a3b8',
                cursor: 'pointer',
              }}
              title="Show static module imports and function calls only"
            >
              📦 Code
            </button>
            <button
              type="button"
              onClick={() => handleSelectRelationshipFilter('http')}
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '3px 7px',
                borderRadius: '3px',
                border: 'none',
                background: relationshipFilter === 'http' ? 'rgba(6, 182, 212, 0.25)' : 'transparent',
                color: relationshipFilter === 'http' ? '#22d3ee' : '#94a3b8',
                cursor: 'pointer',
              }}
              title="Show HTTP API endpoints and client requests only"
            >
              🌐 HTTP
            </button>
          </div>

          {(onExpandNextLevel || onExpandAll || onCollapseAll) && (
            <>
              <span
                style={{
                  width: '1px',
                  height: '18px',
                  background: '#334155',
                  margin: '0 2px',
                }}
              />
              {onExpandNextLevel && (
                <button
                  type="button"
                  onClick={onExpandNextLevel}
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '4px 9px',
                    borderRadius: '4px',
                    background: '#1e293b',
                    color: '#38bdf8',
                    border: '1px solid #334155',
                    cursor: 'pointer',
                  }}
                  title="Expand visible folders one level deeper (folders -> subfolders -> files)"
                >
                  Expand Level
                </button>
              )}
              {onExpandAll && (
                <button
                  type="button"
                  onClick={onExpandAll}
                  style={{
                    fontSize: '11px',
                    fontWeight: 500,
                    padding: '4px 9px',
                    borderRadius: '4px',
                    background: 'transparent',
                    color: '#e2e8f0',
                    border: '1px solid #334155',
                    cursor: 'pointer',
                  }}
                  title="Expand all nested folders and files"
                >
                  Expand All
                </button>
              )}
              {onCollapseAll && (
                <button
                  type="button"
                  onClick={onCollapseAll}
                  style={{
                    fontSize: '11px',
                    fontWeight: 500,
                    padding: '4px 9px',
                    borderRadius: '4px',
                    background: 'transparent',
                    color: '#cbd5e1',
                    border: '1px solid #334155',
                    cursor: 'pointer',
                  }}
                  title="Collapse all directories to top-level view"
                >
                  Collapse All
                </button>
              )}
            </>
          )}
        </div>

        {/* Dynamic Architectural Breadcrumbs */}
        <Breadcrumbs
          repository={activeRepository}
          selectedFileOrNodeId={effectiveSelectedNodeId}
          expandedFolders={effectiveExpanded}
          onNavigateCrumb={handleNavigateCrumb}
        />
      </div>

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
        key={
          isBackendMode
            ? `backend:${activeRepository?.repository || 'live'}:${activeRepository?.commitSha || 'head'}`
            : 'mock:cartograph'
        }
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
        elevateEdgesOnSelect={true}
        onlyRenderVisibleElements={true}
        minZoom={0.08}
        maxZoom={2.0}
        fitView
        fitViewOptions={{ padding: 0.14 }}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <ViewportFocusHandler
          focusTargetId={focusTargetId}
          onFocusDone={() => setFocusTargetId(null)}
        />
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#1c2533"
        />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor={(node) => {
            if (node.type === 'folder') return '#1e293b'
            const kind = node.data?.kind || (node.data?.file && node.data.file.kind)
            if (kind === 'entry') return '#a855f7'
            if (kind === 'component' || kind === 'source') return '#38bdf8'
            if (kind === 'hook') return '#14b8a6'
            if (kind === 'utility') return '#10b981'
            if (kind === 'config') return '#f59e0b'
            if (kind === 'doc') return '#64748b'
            return '#334155'
          }}
          maskColor="rgba(7, 11, 18, 0.75)"
          className="map-minimap"
          position="bottom-right"
        />
      </ReactFlow>
    </div>
  )
}
