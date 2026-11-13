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
  fetchGraphSummary,
  requestBuildGraph,
  fetchGraphNodes,
  fetchNeighborhood,
  fetchIncomingEdges,
  fetchOutgoingEdges,
  fetchEdgeEvidence,
} from './lib/api'
import { transformGraphToFlowElements } from './lib/graphTransformer'
import {
  buildFileMap,
  getFileNeighbours,
  getFolders,
} from './lib/repositoryGraph'

const EMPTY_NEIGHBOURS = { imports: [], importedBy: [] }

function AppContent() {
  const { isSignedIn, getToken, orgId } = useAuth()

  // General navigation & theme
  const [expandedFolder, setExpandedFolder] = useState(null)
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
  const commitSha = graphSummary?.commitSha

  // Live graph elements (React Flow format with canonical IDs)
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
  const folders = useMemo(() => getFolders(sampleRepository), [])
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

        const activeRevisionSha = summary.commitSha

        // 2. Fetch initial nodes using authoritative revision SHA
        const nodesResult = await fetchGraphNodes(
          repositoryId,
          token,
          orgId,
          { page: 1, pageSize: 80, commitSha: activeRevisionSha },
        )

        if (requestIdRef.current !== currentReq) return

        const initialNodes = (nodesResult && nodesResult.nodes) || []
        if (initialNodes.length === 0) {
          setBackendNodes([])
          setBackendEdges([])
          setGraphState('empty')
          return
        }

        // 3. Query bounded neighborhood around primary node (or first node)
        const primaryCenterNode =
          initialNodes.find((n) => n.path && (n.path.includes('index') || n.path.includes('main') || n.path.includes('App'))) ||
          initialNodes[0]

        let flowElements = null
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
          // If neighborhood query fails or center node has no edges, fallback to initialNodes
        }

        if (!flowElements || flowElements.nodes.length === 0) {
          flowElements = transformGraphToFlowElements({ nodes: initialNodes, edges: [] })
        }

        setBackendNodes(flowElements.nodes)
        setBackendEdges(flowElements.edges)
        setIsTruncated(flowElements.truncated)
        setGraphState('available')
      } catch (err) {
        if (requestIdRef.current !== currentReq) return
        setGraphState('error')
        setGraphErrorMessage(err.message || 'Failed to load repository graph.')
      }
    },
    [getToken, orgId],
  )

  // Trigger server-side graph build
  const handleBuildGraph = async () => {
    if (!activeRepoId || isBuildingGraph) return
    setIsBuildingGraph(true)
    setNotice('Building dependency graph from source files...')

    try {
      const token = await getToken()
      await requestBuildGraph(activeRepoId, token, orgId, { ref: 'HEAD' })
      setNotice('Graph built successfully.')
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
          setExpandedFolder(file.folder)
          setSelectedFileId(nodeId)
        }
        return
      }

      // Fetch node incoming & outgoing edges
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
    [activeRepoId, fileMap, getToken, orgId, commitSha],
  )

  // Edge selection handler (provenance)
  const handleSelectEdge = useCallback(
    async (edgeId) => {
      setSelectedEdgeId(edgeId)
      setSelectedNodeId(null) // deselect node
      setIsLoadingEvidence(true)
      setEvidenceError(null)

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

  const handleToggleFolder = useCallback(
    (folderId) => {
      const next = expandedFolder === folderId ? null : folderId
      if (selectedFile) {
        const shouldClear =
          next === null
            ? selectedFile.folder === expandedFolder
            : selectedFile.folder !== next
        if (shouldClear) setSelectedFileId(null)
      }
      setExpandedFolder(next)
    },
    [expandedFolder, selectedFile],
  )

  const handleClearSelection = useCallback(() => {
    setSelectedFileId(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
  }, [])

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
            <LeftRail repository={sampleRepository} folderCount={folders.length} />

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
                backendNodes={backendNodes}
                backendEdges={backendEdges}
                isTruncated={isTruncated}
                expandedFolder={expandedFolder}
                selectedFileId={selectedFileId}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onToggleFolder={handleToggleFolder}
                onSelectFile={handleSelectNode}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onClearSelection={handleClearSelection}
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
              />
            )}

            {/* Node details panel when a node is clicked */}
            {(activeBackendNode || selectedFile) && !selectedEdgeId && (
              <DetailPanel
                backendNode={activeBackendNode}
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
            selectedNode={activeBackendNode}
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
