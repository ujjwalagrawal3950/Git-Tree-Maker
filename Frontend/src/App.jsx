import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SignInButton, useAuth } from '@clerk/react'
import DetailPanel from './components/DetailPanel'
import LeftRail from './components/LeftRail'
import StatusBar from './components/StatusBar'
import TopBar from './components/TopBar'
import { CloseIcon, InfoIcon } from './components/Icons'
import DependencyMap from './components/map/DependencyMap'
import ProvenancePanel from './components/ProvenancePanel'
import UnresolvedReferencesPanel from './components/UnresolvedReferencesPanel'
import { sampleRepository } from './data/sampleRepository'
import { useTheme } from './hooks/useTheme'
import { isValidGithubRepositoryUrl } from './lib/githubUrl'
import {
  verifyRepositoryUrl,
  fetchRepositoryManifest,
  fetchGraphSummary,
  requestBuildGraph,
  fetchGraphNodes,
  fetchGraphEdges,
  fetchNeighborhood,
  fetchIncomingEdges,
  fetchOutgoingEdges,
  fetchEdgeEvidence,
} from './lib/api'
import { transformGraphToFlowElements } from './lib/graphTransformer'
import {
  buildFileMap,
  deriveDirectoryHierarchy,
  getFileNeighbours,
  mergeManifestWithGraph,
} from './lib/repositoryGraph'

const EMPTY_NEIGHBOURS = { imports: [], importedBy: [] }

function AppContent() {
  const { isSignedIn, getToken, orgId } = useAuth()

  // General navigation & theme
  const [expandedFolders, setExpandedFolders] = useState(() => new Set(['components']))
  const expandedFolder = useMemo(() => {
    return Array.from(expandedFolders).join(', ')
  }, [expandedFolders])
  const [crossDirectoryOnly, setCrossDirectoryOnly] = useState(false)
  const [relationshipFilter, setRelationshipFilter] = useState('all') // 'all' | 'code' | 'http'
  const [viewMode, setViewMode] = useState('detailed') // 'architecture' | 'detailed'
  const detailedExpandedFoldersRef = useRef(new Set(['components']))
  const [repoUrl, setRepoUrl] = useState('')
  const [notice, setNotice] = useState(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const { preference, setPreference } = useTheme()

  // Active verified repository & live graph state
  const [activeRepoId, setActiveRepoId] = useState(null)
  const [graphSummary, setGraphSummary] = useState(null)
  const [graphState, setGraphState] = useState('idle') // 'idle' | 'loading' | 'not_built' | 'empty' | 'available' | 'forbidden' | 'error'
  const [graphErrorMessage, setGraphErrorMessage] = useState(null)
  const [isBuildingGraph, setIsBuildingGraph] = useState(false)
  const commitSha = graphSummary?.revision?.commitSha || graphSummary?.commitSha

  // Live graph elements (React Flow format with canonical IDs)
  const [manifestRepository, setManifestRepository] = useState(null)
  const [backendNodes, setBackendNodes] = useState([])
  const [backendEdges, setBackendEdges] = useState([])
  const [isTruncated, setIsTruncated] = useState(false)

  // Node selection & details
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [incomingEdges, setIncomingEdges] = useState([])
  const [outgoingEdges, setOutgoingEdges] = useState([])
  const [isLoadingNodeDetails, setIsLoadingNodeDetails] = useState(false)

  // Edge selection & provenance
  const [selectedEdgeId, setSelectedEdgeId] = useState(null)
  const [edgeEvidenceData, setEdgeEvidenceData] = useState(null)
  const [isLoadingEvidence, setIsLoadingEvidence] = useState(false)
  const [evidenceError, setEvidenceError] = useState(null)

  // Unresolved references panel
  const [isUnresolvedOpen, setIsUnresolvedOpen] = useState(false)

  // Fallback mock repository state (when no live repo is active)
  const [selectedFileId, setSelectedFileId] = useState(null)
  const fileMap = useMemo(() => buildFileMap(sampleRepository), [])
  const selectedFile = selectedFileId ? fileMap.get(selectedFileId) : null
  const neighbours = useMemo(
    () =>
      selectedFileId
        ? getFileNeighbours(sampleRepository, selectedFileId)
        : EMPTY_NEIGHBOURS,
    [selectedFileId],
  )

  // Request sequence ID to prevent race conditions & stale responses
  const requestIdRef = useRef(0)

  const canSubmit = isValidGithubRepositoryUrl(repoUrl)

  // Load backend graph for a given repository ID
  const loadRepositoryGraph = useCallback(
    async (repositoryId) => {
      const currentReq = ++requestIdRef.current
      setGraphState('loading')
      setGraphErrorMessage(null)
      setSelectedNodeId(null)
      setSelectedEdgeId(null)

      try {
        const token = await getToken()
        if (requestIdRef.current !== currentReq) return

        // 1. Fetch summary
        let summary
        try {
          summary = await fetchGraphSummary(repositoryId, token, orgId)
        } catch (err) {
          if (requestIdRef.current !== currentReq) return
          if (err.status === 404) {
            setGraphSummary(null)
            setGraphState('not_built')
            return
          }
          if (err.status === 403) {
            setGraphSummary(null)
            setGraphState('forbidden')
            setGraphErrorMessage('You do not have permission to access this repository graph.')
            return
          }
          throw err
        }

        if (requestIdRef.current !== currentReq) return
        setGraphSummary(summary)
        if (summary?.statistics?.isPartial) {
          setNotice('Repository graph represents partial ingestion budget. Run incremental ingestion for complete coverage.')
        }

        const activeRevisionSha = summary?.revision?.commitSha || summary?.commitSha

        // 2. Fetch authoritative repository manifest
        const targetUrl = repoUrl || `https://github.com/${repositoryId}`
        let manifest
        try {
          manifest = await fetchRepositoryManifest(targetUrl, token, orgId, activeRevisionSha)
        } catch (err) {
          if (requestIdRef.current !== currentReq) return
          setGraphSummary(null)
          setManifestRepository(null)
          setBackendNodes([])
          setBackendEdges([])
          setGraphState('error')
          setGraphErrorMessage(
            err.message || 'Repository manifest unavailable. Complete repository containment cannot be verified.',
          )
          return
        }

        if (requestIdRef.current !== currentReq) return

        if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
          setManifestRepository(null)
          setBackendNodes([])
          setBackendEdges([])
          setGraphState('empty')
          return
        }

        // Verify that manifest and graph snapshot belong to the same commit
        if (manifest.commitSha && activeRevisionSha && manifest.commitSha !== activeRevisionSha) {
          setGraphSummary(null)
          setManifestRepository(null)
          setBackendNodes([])
          setBackendEdges([])
          setGraphState('error')
          setGraphErrorMessage(
            `Commit mismatch: graph snapshot (${activeRevisionSha.slice(0, 7)}) does not match manifest (${manifest.commitSha.slice(0, 7)}).`,
          )
          return
        }

        // 3. Fetch ALL file nodes, symbol nodes, and dependency edges across pages
        // (Excluding structural contains/defines edges prevents pagination truncation of real imports/calls)
        const fetchAllPaginated = async (fetcher, maxPages = 5) => {
          const collected = []
          const first = await fetcher(1)
          const firstItems = (first && (first.nodes || first.edges)) || []
          collected.push(...firstItems)
          const totalPages = Math.min(maxPages, Number(first?.totalPages) || 1)
          if (totalPages > 1) {
            const restPromises = []
            for (let p = 2; p <= totalPages; p++) {
              restPromises.push(fetcher(p).catch(() => null))
            }
            const restPages = await Promise.all(restPromises)
            for (const pageRes of restPages) {
              const items = (pageRes && (pageRes.nodes || pageRes.edges)) || []
              collected.push(...items)
            }
          }
          return { items: collected, truncated: (Number(first?.totalPages) || 1) > maxPages }
        }

        const [fileNodesRes, symbolNodesRes, edgesRes] = await Promise.all([
          fetchAllPaginated(
            (page) =>
              fetchGraphNodes(repositoryId, token, orgId, {
                type: 'file',
                page,
                pageSize: 500,
                commitSha: activeRevisionSha,
              }),
            5,
          ),
          fetchAllPaginated(
            (page) =>
              fetchGraphNodes(repositoryId, token, orgId, {
                type: 'symbol',
                page,
                pageSize: 500,
                commitSha: activeRevisionSha,
              }),
            5,
          ).catch(() => ({ items: [], truncated: false })),
          fetchAllPaginated(
            (page) =>
              fetchGraphEdges(repositoryId, token, orgId, {
                excludeTypes: ['contains', 'defines', 'member_of'],
                page,
                pageSize: 1000,
                commitSha: activeRevisionSha,
              }),
            5,
          ).catch(() => ({ items: [], truncated: false })),
        ])

        if (requestIdRef.current !== currentReq) return

        const initialNodes = [...fileNodesRes.items, ...symbolNodesRes.items]
        const fetchedEdges = edgesRes.items

        // 4. Transform graph elements, using full repository edges whenever available
        let flowElements = null
        if (initialNodes.length > 0 && fetchedEdges.length > 0) {
          flowElements = transformGraphToFlowElements({
            nodes: initialNodes,
            edges: fetchedEdges,
            truncated: fileNodesRes.truncated || edgesRes.truncated,
          })
        } else if (initialNodes.length > 0) {
          const primaryCenterNode =
            initialNodes.find((n) => n.path && (n.path.includes('index') || n.path.includes('main') || n.path.includes('App'))) ||
            initialNodes[0]

          try {
            const neighborhood = await fetchNeighborhood(
              repositoryId,
              primaryCenterNode.id,
              token,
              orgId,
              { maxDepth: 2, maxNodes: 80, commitSha: activeRevisionSha },
            )
            if (requestIdRef.current !== currentReq) return

            if (neighborhood && Array.isArray(neighborhood.nodes) && neighborhood.nodes.length > 0) {
              flowElements = transformGraphToFlowElements(neighborhood)
            }
          } catch {
            // If neighborhood query fails, fallback to initialNodes
          }

          if (!flowElements || flowElements.nodes.length === 0) {
            flowElements = transformGraphToFlowElements({ nodes: initialNodes, edges: [] })
          }
        }

        // 5. Merge complete repository manifest with graph elements
        const mergedRepo = mergeManifestWithGraph({
          manifest,
          graphSummary: summary,
          graphNodes: flowElements ? flowElements.nodes : [],
          graphEdges: flowElements ? flowElements.edges : [],
        })

        setManifestRepository(mergedRepo)
        setBackendNodes(flowElements ? flowElements.nodes : [])
        setBackendEdges(flowElements ? flowElements.edges : [])
        setIsTruncated(flowElements ? flowElements.truncated : false)
        setExpandedFolders(new Set())
        setGraphState('available')
      } catch (err) {
        if (requestIdRef.current !== currentReq) return
        setManifestRepository(null)
        setGraphState('error')
        setGraphErrorMessage(err.message || 'Failed to load repository graph.')
      }
    },
    [getToken, orgId, repoUrl],
  )

  // Trigger server-side graph build
  const handleBuildGraph = async () => {
    if (!activeRepoId || isBuildingGraph) return
    setIsBuildingGraph(true)
    setNotice('Building dependency graph from source files...')

    try {
      const token = await getToken()
      const buildRes = await requestBuildGraph(activeRepoId, token, orgId, { ref: 'HEAD' })
      if (buildRes?.data?.statistics?.isPartial) {
        setNotice('Graph built (partial ingestion budget reached; additional files can be retrieved via batch ingestion).')
      } else {
        setNotice('Graph built successfully.')
      }
      await loadRepositoryGraph(activeRepoId)
    } catch (err) {
      setNotice(err.message || 'Failed to build dependency graph.')
    } finally {
      setIsBuildingGraph(false)
    }
  };

  // Node selection handler
  const handleSelectNode = useCallback(
    async (nodeId) => {
      setSelectedNodeId(nodeId)
      setSelectedEdgeId(null) // deselect edge

      if (!activeRepoId) {
        // mock mode
        const file = fileMap.get(nodeId)
        if (file) {
          setExpandedFolders((prev) => {
            const next = new Set(prev instanceof Set ? prev : [prev].filter(Boolean))
            for (const dirId of file.ancestors || [file.folder]) {
              next.add(dirId)
            }
            return next
          })
          setSelectedFileId(nodeId)
        }
        return
      }

      // Check whether this file is an unparsed manifest file
      const manifestFile = manifestRepository?.files?.find(
        (f) => f.id === nodeId || f.path === nodeId,
      )

      if (manifestFile && !manifestFile.isParsed) {
        setIncomingEdges([])
        setOutgoingEdges([])
        setIsLoadingNodeDetails(false)
        return
      }

      // Fetch node incoming & outgoing edges for parsed files
      setIsLoadingNodeDetails(true)
      try {
        const token = await getToken()
        const [incomingRes, outgoingRes] = await Promise.all([
          fetchIncomingEdges(activeRepoId, nodeId, token, orgId, commitSha),
          fetchOutgoingEdges(activeRepoId, nodeId, token, orgId, commitSha),
        ])
        setIncomingEdges(incomingRes?.edges || [])
        setOutgoingEdges(outgoingRes?.edges || [])
      } catch {
        // Safe fallback
        setIncomingEdges([])
        setOutgoingEdges([])
      } finally {
        setIsLoadingNodeDetails(false)
      }
    },
    [activeRepoId, fileMap, getToken, orgId, commitSha, manifestRepository],
  )

  // Edge selection handler (provenance)
  const handleSelectEdge = useCallback(
    async (edgeId, edgeData = null) => {
      setSelectedEdgeId(edgeId)
      setSelectedNodeId(null) // deselect node
      setSelectedFileId(null)
      setIsLoadingEvidence(true)
      setEvidenceError(null)

      if (!edgeId) {
        setEdgeEvidenceData(null)
        setIsLoadingEvidence(false)
        return
      }

      // Safeguard 8: Aggregated edge selection must use client-side underlying edge records.
      // Never send an aggregate folder edge ID to the canonical backend edge-evidence endpoint.
      if (
        edgeData?.isAggregated ||
        (edgeData?.underlyingEdges && edgeData.underlyingEdges.length > 0) ||
        edgeId.startsWith('edge:folder:')
      ) {
        setEdgeEvidenceData({
          isAggregated: true,
          edgeId,
          source: edgeData?.source || (edgeId.replace(/^edge:/, '').split('\u0000')[0] || ''),
          target: edgeData?.target || (edgeId.replace(/^edge:/, '').split('\u0000')[1] || ''),
          count: edgeData?.count || edgeData?.underlyingEdges?.length || 1,
          baseLabel: edgeData?.baseLabel || 'dependencies',
          type: edgeData?.baseLabel || 'aggregated',
          underlyingEdges: edgeData?.underlyingEdges || [],
          isCrossDirectory: edgeData?.isCrossDirectory,
          isCrossSubsystem: edgeData?.isCrossSubsystem,
        })
        setIsLoadingEvidence(false)
        return
      }

      if (!activeRepoId) {
        setIsLoadingEvidence(false)
        return
      }

      try {
        const token = await getToken()
        const evidence = await fetchEdgeEvidence(
          activeRepoId,
          edgeId,
          token,
          orgId,
          commitSha,
        )
        setEdgeEvidenceData(evidence)
      } catch (err) {
        setEvidenceError(err)
        setEdgeEvidenceData(null)
      } finally {
        setIsLoadingEvidence(false)
      }
    },
    [activeRepoId, getToken, orgId, commitSha],
  )

  const handleToggleCrossDirectory = useCallback(() => {
    setCrossDirectoryOnly((prev) => !prev)
  }, [])

  const handleToggleViewMode = useCallback(
    (mode) => {
      setViewMode((prevMode) => {
        if (prevMode === mode) return prevMode
        if (mode === 'architecture') {
          // Safeguard 5: Save detailed expansion state before switching to architecture overview
          detailedExpandedFoldersRef.current = new Set(expandedFolders)
          setExpandedFolders(new Set())
        } else {
          // Restore user's previous detailed expansion state
          const restored =
            detailedExpandedFoldersRef.current && detailedExpandedFoldersRef.current.size > 0
              ? detailedExpandedFoldersRef.current
              : new Set(['components'])
          setExpandedFolders(new Set(restored))
        }
        return mode
      })
    },
    [expandedFolders],
  )

  // Expand neighborhood around center node
  const handleExpandNeighborhood = useCallback(
    async (centerId) => {
      if (!activeRepoId || !centerId) return
      try {
        const token = await getToken()
        const expansion = await fetchNeighborhood(
          activeRepoId,
          centerId,
          token,
          orgId,
          { depth: 1, maxNodes: 50, commitSha },
        )

        const newElements = transformGraphToFlowElements(expansion)

        // Merge nodes and edges without duplicates while preserving canonical IDs
        setBackendNodes((prevNodes) => {
          const map = new Map(prevNodes.map((n) => [n.id, n]))
          for (const node of newElements.nodes) {
            if (!map.has(node.id)) map.set(node.id, node)
          }
          return Array.from(map.values())
        })

        setBackendEdges((prevEdges) => {
          const map = new Map(prevEdges.map((e) => [e.id, e]))
          for (const edge of newElements.edges) {
            if (!map.has(edge.id)) map.set(edge.id, edge)
          }
          return Array.from(map.values())
        })

        if (newElements.truncated) {
          setIsTruncated(true)
        }
      } catch (err) {
        setNotice(err.message || 'Could not expand neighborhood.')
      }
    },
    [activeRepoId, getToken, orgId, commitSha],
  )

  const activeHierarchy = useMemo(
    () => deriveDirectoryHierarchy(manifestRepository || sampleRepository),
    [manifestRepository],
  )

  const handleToggleFolder = useCallback(
    (folderId) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev instanceof Set ? prev : [prev].filter(Boolean))
        if (next.has(folderId)) {
          next.delete(folderId)
        } else {
          next.add(folderId)
        }
        return next
      })
    },
    [],
  )

  const handleExpandNextLevel = useCallback(() => {
    setExpandedFolders((prev) => {
      const current = new Set(prev instanceof Set ? prev : [prev].filter(Boolean))
      const next = new Set(current)

      for (const dirNode of activeHierarchy.folderMap.values()) {
        if (current.has(dirNode.id)) continue
        // Expand if top-level or if its direct parent is already expanded
        if (dirNode.parentId === null || current.has(dirNode.parentId)) {
          next.add(dirNode.id)
        }
      }
      return next
    })
  }, [activeHierarchy])

  const handleExpandAll = useCallback(() => {
    setExpandedFolders(new Set(activeHierarchy.folderMap.keys()))
  }, [activeHierarchy])

  const handleCollapseAll = useCallback(() => {
    setExpandedFolders(new Set())
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelectedFileId(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
  }, [])

  const handleNavigateToItem = useCallback(
    (item) => {
      if (!item) return
      if (item.type === 'folder') {
        setExpandedFolders((prev) => {
          const next = new Set(prev instanceof Set ? prev : [prev].filter(Boolean))
          for (const anc of item.ancestors || []) {
            next.add(anc)
          }
          next.add(item.id)
          return next
        })
        setSelectedNodeId(`folder:${item.id}`)
        setSelectedFileId(null)
      } else {
        // file or symbol
        setExpandedFolders((prev) => {
          const next = new Set(prev instanceof Set ? prev : [prev].filter(Boolean))
          for (const anc of item.ancestors || []) {
            next.add(anc)
          }
          return next
        })
        const targetId = item.fileId || item.id
        handleSelectNode(targetId)
      }
    },
    [handleSelectNode],
  )

  // Verify and load repository
  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!canSubmit || isVerifying) return

    if (!isSignedIn) {
      setNotice('Please sign in to verify repositories.')
      return
    }

    if (!orgId) {
      setNotice('Please select or create an organization in the top right.')
      return
    }

    setIsVerifying(true)
    setNotice('Checking repository...')

    try {
      const token = await getToken()
      const repoData = await verifyRepositoryUrl(repoUrl, token, orgId)
      const repoIdentifier = repoData.id || repoData.fullName
      setActiveRepoId(repoIdentifier)
      setNotice(`Repository verified: ${repoData.fullName}`)
      await loadRepositoryGraph(repoIdentifier)
    } catch (error) {
      setNotice(error.message || 'Repository verification failed.')
    } finally {
      setIsVerifying(false)
    }
  }

  // Escape key deselects
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') handleClearSelection()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleClearSelection])

  // Active node lookup for DetailPanel
  const activeBackendNode = useMemo(() => {
    if (!selectedNodeId) return null
    return backendNodes.find((n) => n.id === selectedNodeId) || null
  }, [selectedNodeId, backendNodes])

  const activeManifestFile = useMemo(() => {
    if (!selectedNodeId || !manifestRepository?.files) return null
    return (
      manifestRepository.files.find(
        (f) => f.id === selectedNodeId || f.path === selectedNodeId,
      ) || null
    )
  }, [selectedNodeId, manifestRepository])

  return (
    <div className="app-shell">
      <TopBar
        preference={preference}
        onPreferenceChange={setPreference}
        repoUrl={repoUrl}
        onRepoUrlChange={setRepoUrl}
        onSubmit={handleSubmit}
        canSubmit={canSubmit}
        isVerifying={isVerifying}
      />

      {notice && (
        <div className="notice-bar" role="status">
          <span className="notice-bar__icon">
            <InfoIcon />
          </span>
          <span>{notice}</span>
          <button
            type="button"
            className="icon-button notice-bar__close"
            aria-label="Dismiss notice"
            title="Dismiss notice"
            onClick={() => setNotice(null)}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {isSignedIn ? (
        <>
          <main className="app-main" style={{ position: 'relative' }}>
            <LeftRail
              repository={
                manifestRepository
                  ? {
                      name: manifestRepository.repository || activeRepoId || 'Repository',
                      branch: commitSha ? commitSha.slice(0, 7) : 'HEAD',
                      files: manifestRepository.files,
                      edges: manifestRepository.edges,
                      isLive: true,
                    }
                  : sampleRepository
              }
              folderCount={activeHierarchy.folderMap.size}
              onNavigateToItem={handleNavigateToItem}
              onSelectFile={handleSelectNode}
            />

            <section className="map-region" aria-label="Dependency map" style={{ position: 'relative' }}>
              {graphState === 'loading' && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 20,
                    background: 'rgba(15, 23, 42, 0.75)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text)',
                    backdropFilter: 'blur(2px)',
                  }}
                >
                  <p style={{ fontSize: '14px', fontWeight: 500 }}>Loading dependency graph...</p>
                </div>
              )}

              {graphState === 'not_built' && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 20,
                    background: 'var(--canvas)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '24px',
                    textAlign: 'center',
                  }}
                >
                  <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>
                    Graph Snapshot Not Built
                  </h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '420px', margin: '8px 0 16px 0' }}>
                    No dependency graph snapshot has been built yet for this repository revision.
                  </p>
                  <button
                    type="button"
                    disabled={isBuildingGraph}
                    onClick={handleBuildGraph}
                    style={{
                      padding: '8px 16px',
                      borderRadius: '6px',
                      background: 'var(--brand, #38bdf8)',
                      color: '#0f172a',
                      fontWeight: 600,
                      border: 'none',
                      cursor: isBuildingGraph ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {isBuildingGraph ? 'Building Graph...' : 'Build Dependency Graph'}
                  </button>
                </div>
              )}

              {graphState === 'empty' && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 20,
                    background: 'var(--canvas)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-muted)',
                  }}
                >
                  <p>Empty graph: no dependencies found in this repository.</p>
                </div>
              )}

              {graphState === 'forbidden' && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 20,
                    background: 'var(--canvas)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#ef4444',
                    padding: '24px',
                  }}
                >
                  <p style={{ fontWeight: 600 }}>Permission Denied</p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {graphErrorMessage || 'You do not have permission to access this repository graph.'}
                  </p>
                </div>
              )}

              {graphState === 'error' && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 20,
                    background: 'var(--canvas)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '24px',
                  }}
                >
                  <p style={{ color: '#ef4444', fontWeight: 600 }}>Graph Request Failed</p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
                    {graphErrorMessage}
                  </p>
                  <button
                    type="button"
                    onClick={() => loadRepositoryGraph(activeRepoId)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '4px',
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}

              <DependencyMap
                repository={sampleRepository}
                manifestRepository={manifestRepository}
                backendNodes={backendNodes}
                backendEdges={backendEdges}
                isTruncated={isTruncated}
                expandedFolder={expandedFolder}
                expandedFolders={expandedFolders}
                selectedFileId={selectedFileId}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                viewMode={viewMode}
                onToggleViewMode={handleToggleViewMode}
                crossDirectoryOnly={crossDirectoryOnly}
                onToggleCrossDirectory={handleToggleCrossDirectory}
                relationshipFilter={relationshipFilter}
                onSelectRelationshipFilter={setRelationshipFilter}
                onToggleFolder={handleToggleFolder}
                onExpandNextLevel={handleExpandNextLevel}
                onExpandAll={handleExpandAll}
                onCollapseAll={handleCollapseAll}
                onSelectFile={handleSelectNode}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onClearSelection={handleClearSelection}
                onNavigateToItem={handleNavigateToItem}
              />
            </section>

            {/* Edge provenance panel when an edge is clicked */}
            {selectedEdgeId && (
              <ProvenancePanel
                edgeId={selectedEdgeId}
                evidenceData={edgeEvidenceData}
                isLoading={isLoadingEvidence}
                error={evidenceError}
                onClose={() => setSelectedEdgeId(null)}
                onNavigateToItem={handleNavigateToItem}
              />
            )}

            {/* Node details panel when a node is clicked */}
            {(activeBackendNode || activeManifestFile || selectedFile) && !selectedEdgeId && (
              <DetailPanel
                repository={manifestRepository || sampleRepository}
                backendNode={activeBackendNode}
                manifestFile={activeManifestFile}
                incomingEdges={incomingEdges}
                outgoingEdges={outgoingEdges}
                isLoadingDetails={isLoadingNodeDetails}
                onExpandNeighborhood={handleExpandNeighborhood}
                file={selectedFile}
                neighbours={neighbours}
                fileMap={fileMap}
                onSelectNode={handleSelectNode}
                onSelectFile={handleSelectNode}
                onClose={handleClearSelection}
              />
            )}
          </main>

          <StatusBar
            repository={sampleRepository}
            graphSummary={graphSummary}
            expandedFolder={expandedFolder}
            selectedFile={selectedFile}
            selectedNode={
              activeBackendNode ||
              (activeManifestFile
                ? { id: activeManifestFile.id, data: activeManifestFile }
                : null)
            }
            crossDirectoryOnly={crossDirectoryOnly}
            relationshipFilter={relationshipFilter}
            viewMode={viewMode}
            onOpenUnresolved={() => setIsUnresolvedOpen(true)}
          />

          <UnresolvedReferencesPanel
            repositoryId={activeRepoId}
            getToken={getToken}
            orgId={orgId}
            isOpen={isUnresolvedOpen}
            onClose={() => setIsUnresolvedOpen(false)}
          />
        </>
      ) : (
        <main className="signed-out-container">
          <div className="signed-out-card">
            <h2>Welcome to Cartograph</h2>
            <p>Please sign in to visualize repository structures and dependencies.</p>
            <SignInButton mode="modal">
              <button className="button-primary" type="button">
                Sign In to Explore
              </button>
            </SignInButton>
          </div>
        </main>
      )}
    </div>
  )
}

export default function App() {
  const { isLoaded } = useAuth()

  if (!isLoaded) {
    return (
      <div className="app-loading-screen">
        <p>Loading Cartograph...</p>
      </div>
    )
  }

  return <AppContent />
}
