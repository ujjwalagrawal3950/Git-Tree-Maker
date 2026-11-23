import { useEffect, useMemo, useRef, useState } from 'react'
import { CloseIcon, FolderIcon, FileIcon, SearchIcon } from '../Icons'
import { buildSearchIndex, searchRepository } from '../../lib/searchIndex'

export default function SearchBar({
  repository,
  onNavigateToItem,
  className = '',
}) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef(null)
  const containerRef = useRef(null)

  // Memoize search index over active repository
  const searchIndex = useMemo(() => {
    if (!repository) return null
    return buildSearchIndex(repository)
  }, [repository])

  // Compute search results
  const results = useMemo(() => {
    if (!searchIndex || !query.trim()) return []
    return searchRepository(searchIndex, query, 12)
  }, [searchIndex, query])

  // Global keyboard shortcut: Ctrl+K, Cmd+K, or "/"
  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeTag = document.activeElement?.tagName?.toLowerCase()
      const isInput = activeTag === 'input' || activeTag === 'textarea' || document.activeElement?.isContentEditable

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setIsOpen(true)
      } else if (e.key === '/' && !isInput) {
        e.preventDefault()
        inputRef.current?.focus()
        setIsOpen(true)
      } else if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Reset highlight index when query or results change
  useEffect(() => {
    setHighlightedIndex(0)
  }, [results])

  const handleSelect = (item) => {
    if (!item) return
    setIsOpen(false)
    setQuery('')
    if (typeof onNavigateToItem === 'function') {
      onNavigateToItem(item)
    }
  }

  const handleKeyDown = (e) => {
    if (!isOpen || results.length === 0) {
      if (e.key === 'ArrowDown' && query.trim()) {
        setIsOpen(true)
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (results[highlightedIndex]) {
        handleSelect(results[highlightedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setIsOpen(false)
    }
  }

  return (
    <div
      ref={containerRef}
      className={`map-search-bar ${className}`}
      style={{ position: 'relative' }}
    >
      <div className="map-search-input-wrapper">
        <span className="map-search-icon">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search files, folders, symbols... (/)"
          className="map-search-input"
          aria-label="Search files, folders, and symbols"
          aria-expanded={isOpen && results.length > 0}
          onFocus={() => {
            if (query.trim()) setIsOpen(true)
          }}
          onChange={(e) => {
            setQuery(e.target.value)
            setIsOpen(Boolean(e.target.value.trim()))
          }}
          onKeyDown={handleKeyDown}
        />
        {query ? (
          <button
            type="button"
            className="map-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery('')
              setIsOpen(false)
              inputRef.current?.focus()
            }}
          >
            <CloseIcon />
          </button>
        ) : (
          <span className="map-search-badge">/</span>
        )}
      </div>

      {isOpen && results.length > 0 && (
        <ul
          className="map-search-dropdown"
          role="listbox"
          aria-label="Search suggestions"
        >
          {results.map((item, index) => {
            const isHighlighted = index === highlightedIndex
            return (
              <li
                key={`${item.type}:${item.id}`}
                role="option"
                aria-selected={isHighlighted}
                className={`map-search-item ${isHighlighted ? 'is-highlighted' : ''}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => handleSelect(item)}
              >
                <span className="map-search-item__icon">
                  {item.type === 'folder' ? (
                    <FolderIcon />
                  ) : item.type === 'symbol' ? (
                    <span className="symbol-bullet">#</span>
                  ) : (
                    <FileIcon />
                  )}
                </span>
                <div className="map-search-item__content">
                  <div className="map-search-item__title">
                    <span className="map-search-item__name">{item.name}</span>
                    <span className="map-search-item__kind kind-badge">
                      {item.type === 'symbol' ? item.symbolKind : item.kind || item.type}
                    </span>
                  </div>
                  <div className="map-search-item__path">{item.path}</div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
