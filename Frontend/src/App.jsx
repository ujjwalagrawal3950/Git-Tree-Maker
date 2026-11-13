import { useCallback, useEffect, useMemo, useState } from 'react'
import { SignInButton, useAuth } from '@clerk/react'
import DetailPanel from './components/DetailPanel'
import LeftRail from './components/LeftRail'
import StatusBar from './components/StatusBar'
import TopBar from './components/TopBar'
import { CloseIcon, InfoIcon } from './components/Icons'
import DependencyMap from './components/map/DependencyMap'
import { sampleRepository } from './data/sampleRepository'
import { useTheme } from './hooks/useTheme'
import { isValidGithubRepositoryUrl } from './lib/githubUrl'
import { verifyRepositoryUrl } from './lib/api'

import {
  buildFileMap,
  getFileNeighbours,
  getFolders,
} from './lib/repositoryGraph'

const EMPTY_NEIGHBOURS = { imports: [], importedBy: [] }

function AppContent() {
  const { isSignedIn, getToken, orgId } = useAuth()

  const [expandedFolder, setExpandedFolder] = useState(null)
  const [selectedFileId, setSelectedFileId] = useState(null)
  const [repoUrl, setRepoUrl] = useState('')
  const [notice, setNotice] = useState(null)
  const [isVerifying, setIsVerifying] = useState(false)

  const { preference, setPreference } = useTheme()

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

  const canSubmit = isValidGithubRepositoryUrl(repoUrl)

  const handleSelectFile = useCallback(
    (fileId) => {
      const file = fileMap.get(fileId)
      if (!file) return
      setExpandedFolder(file.folder)
      setSelectedFileId(fileId)
    },
    [fileMap],
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
  }, [])

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
      setNotice(`Public repository verified: ${repoData.fullName}`)
    } catch (error) {
      setNotice(error.message || 'Repository verification failed.')
    } finally {
      setIsVerifying(false)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setSelectedFileId(null)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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
          <main className="app-main">
            <LeftRail repository={sampleRepository} folderCount={folders.length} />

            <section className="map-region" aria-label="Dependency map">
              <DependencyMap
                repository={sampleRepository}
                expandedFolder={expandedFolder}
                selectedFileId={selectedFileId}
                onToggleFolder={handleToggleFolder}
                onSelectFile={handleSelectFile}
                onClearSelection={handleClearSelection}
              />
            </section>

            {selectedFile && (
              <DetailPanel
                file={selectedFile}
                neighbours={neighbours}
                fileMap={fileMap}
                onSelectFile={handleSelectFile}
                onClose={handleClearSelection}
              />
            )}
          </main>

          <StatusBar
            repository={sampleRepository}
            expandedFolder={expandedFolder}
            selectedFile={selectedFile}
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
