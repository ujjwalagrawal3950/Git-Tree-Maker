import { useMemo } from 'react'
import { ChevronRightIcon, FileIcon, FolderIcon, LogoIcon } from '../Icons'
import { deriveBreadcrumbs } from '../../lib/searchIndex'

export default function Breadcrumbs({
  repository,
  selectedFileOrNodeId,
  expandedFolders,
  onNavigateCrumb,
  className = '',
}) {
  const crumbs = useMemo(() => {
    return deriveBreadcrumbs(repository, selectedFileOrNodeId, expandedFolders)
  }, [repository, selectedFileOrNodeId, expandedFolders])

  if (!crumbs || crumbs.length === 0) return null

  return (
    <nav
      className={`map-breadcrumbs ${className}`}
      aria-label="Repository navigation breadcrumb"
    >
      <ol className="map-breadcrumbs__list">
        {crumbs.map((crumb, idx) => {
          const isLast = crumb.isLast || idx === crumbs.length - 1

          return (
            <li key={crumb.id || idx} className="map-breadcrumbs__item">
              {idx > 0 && (
                <span className="map-breadcrumbs__separator" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
              )}
              <button
                type="button"
                className={`map-breadcrumbs__btn ${isLast ? 'is-active' : ''}`}
                aria-current={isLast ? 'location' : undefined}
                title={crumb.id !== 'root' ? crumb.id : 'Root overview'}
                onClick={() => {
                  if (typeof onNavigateCrumb === 'function') {
                    onNavigateCrumb(crumb)
                  }
                }}
              >
                <span className="map-breadcrumbs__icon">
                  {crumb.type === 'repo' ? (
                    <LogoIcon size={12} />
                  ) : crumb.type === 'folder' ? (
                    <FolderIcon />
                  ) : (
                    <FileIcon />
                  )}
                </span>
                <span className="map-breadcrumbs__label">{crumb.label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
