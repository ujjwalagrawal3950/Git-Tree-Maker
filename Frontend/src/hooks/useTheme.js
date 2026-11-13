import { useEffect, useState } from 'react'

const STORAGE_KEY = 'cartograph-theme'
const PREFERENCES = ['system', 'light', 'dark']

function readPreference() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return PREFERENCES.includes(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

function readSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function useTheme() {
  const [preference, setPreference] = useState(readPreference)
  const [systemTheme, setSystemTheme] = useState(readSystemTheme)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event) => {
      setSystemTheme(event.matches ? 'dark' : 'light')
    }

    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  const resolvedTheme = preference === 'system' ? systemTheme : preference

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      // Storage can be unavailable; the theme still works for this session.
    }
  }, [preference])

  return { preference, resolvedTheme, setPreference }
}
