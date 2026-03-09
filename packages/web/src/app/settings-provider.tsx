"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  type JinnSettings,
  type EmployeeOverride,
  DEFAULTS,
  loadSettings,
  saveSettings,
  hexToAccentFill,
  hexToContrastText,
} from '@/lib/settings'
import { api } from '@/lib/api'

interface EmployeeDisplay {
  emoji: string
  profileImage?: string
  emojiOnly?: boolean
}

interface SettingsContextValue {
  settings: JinnSettings
  setAccentColor: (color: string | null) => void
  setPortalName: (name: string | null) => void
  setPortalSubtitle: (subtitle: string | null) => void
  setPortalEmoji: (emoji: string | null) => void
  setPortalIcon: (icon: string | null) => void
  setIconBgHidden: (hidden: boolean) => void
  setEmojiOnly: (emojiOnly: boolean) => void
  setOperatorName: (name: string | null) => void
  setLanguage: (language: string) => void
  setEmployeeOverride: (employeeId: string, override: EmployeeOverride) => void
  clearEmployeeOverride: (employeeId: string) => void
  getEmployeeDisplay: (employee: { name: string; emoji: string; id: string }) => EmployeeDisplay
  resetAll: () => void
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: { accentColor: null, portalName: null, portalSubtitle: null, portalEmoji: null, portalIcon: null, iconBgHidden: false, emojiOnly: false, operatorName: null, language: "English", employeeOverrides: {} },
  setAccentColor: () => {},
  setPortalName: () => {},
  setPortalSubtitle: () => {},
  setPortalEmoji: () => {},
  setPortalIcon: () => {},
  setIconBgHidden: () => {},
  setEmojiOnly: () => {},
  setOperatorName: () => {},
  setLanguage: () => {},
  setEmployeeOverride: () => {},
  clearEmployeeOverride: () => {},
  getEmployeeDisplay: (employee) => ({ emoji: employee.emoji }),
  resetAll: () => {},
})

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  // Initialize with defaults so server and client render the same HTML.
  // Hydrate from localStorage after mount to avoid hydration mismatch.
  const [settings, setSettings] = useState<JinnSettings>({ ...DEFAULTS })

  // Hydrate from localStorage first, then always sync portalName/operatorName
  // from backend config (source of truth). This ensures the correct COO name
  // shows up even if localStorage has stale values from a previous onboarding.
  useEffect(() => {
    const local = loadSettings()
    setSettings(local)

    api.getOnboarding()
      .then((data) => {
        if (data.portalName || data.operatorName) {
          const merged = {
            ...local,
            ...(data.portalName && { portalName: data.portalName }),
            ...(data.operatorName && { operatorName: data.operatorName }),
          }
          setSettings(merged)
          saveSettings(merged)
        }
      })
      .catch(() => {
        // Best-effort — localStorage values are fine
      })
  }, [])

  // Apply accent color CSS variables when settings change
  useEffect(() => {
    const el = document.documentElement.style
    if (settings.accentColor) {
      el.setProperty('--accent', settings.accentColor)
      el.setProperty('--accent-fill', hexToAccentFill(settings.accentColor))
      el.setProperty('--accent-contrast', hexToContrastText(settings.accentColor))
    } else {
      el.removeProperty('--accent')
      el.removeProperty('--accent-fill')
      el.removeProperty('--accent-contrast')
    }
  }, [settings.accentColor])

  const update = useCallback((next: JinnSettings) => {
    setSettings(next)
    saveSettings(next)
  }, [])

  const setAccentColor = useCallback(
    (color: string | null) => {
      update({ ...settings, accentColor: color })
    },
    [settings, update],
  )

  const setPortalName = useCallback(
    (name: string | null) => {
      update({ ...settings, portalName: name || null })
    },
    [settings, update],
  )

  const setPortalSubtitle = useCallback(
    (subtitle: string | null) => {
      update({ ...settings, portalSubtitle: subtitle || null })
    },
    [settings, update],
  )

  const setPortalEmoji = useCallback(
    (emoji: string | null) => {
      update({ ...settings, portalEmoji: emoji || null })
    },
    [settings, update],
  )

  const setPortalIcon = useCallback(
    (icon: string | null) => {
      update({ ...settings, portalIcon: icon })
    },
    [settings, update],
  )

  const setIconBgHidden = useCallback(
    (hidden: boolean) => {
      update({ ...settings, iconBgHidden: hidden })
    },
    [settings, update],
  )

  const setEmojiOnly = useCallback(
    (emojiOnly: boolean) => {
      update({ ...settings, emojiOnly })
    },
    [settings, update],
  )

  const setOperatorName = useCallback(
    (name: string | null) => {
      update({ ...settings, operatorName: name || null })
    },
    [settings, update],
  )

  const setLanguage = useCallback(
    (language: string) => {
      update({ ...settings, language: language || "English" })
    },
    [settings, update],
  )

  const setEmployeeOverride = useCallback(
    (employeeId: string, override: EmployeeOverride) => {
      const existing = settings.employeeOverrides[employeeId] || {}
      update({
        ...settings,
        employeeOverrides: {
          ...settings.employeeOverrides,
          [employeeId]: { ...existing, ...override },
        },
      })
    },
    [settings, update],
  )

  const clearEmployeeOverride = useCallback(
    (employeeId: string) => {
      const { [employeeId]: _, ...rest } = settings.employeeOverrides
      update({ ...settings, employeeOverrides: rest })
    },
    [settings, update],
  )

  const getEmployeeDisplay = useCallback(
    (employee: { name: string; emoji: string; id: string }): EmployeeDisplay => {
      const override = settings.employeeOverrides[employee.id]
      return {
        emoji: override?.emoji || employee.emoji,
        profileImage: override?.profileImage,
        emojiOnly: settings.emojiOnly,
      }
    },
    [settings.employeeOverrides, settings.emojiOnly],
  )

  const resetAll = useCallback(() => {
    const defaults: JinnSettings = {
      accentColor: null,
      portalName: null,
      portalSubtitle: null,
      portalEmoji: null,
      portalIcon: null,
      iconBgHidden: false,
      emojiOnly: false,
      operatorName: null,
      language: "English",
      employeeOverrides: {},
    }
    update(defaults)
  }, [update])

  return (
    <SettingsContext.Provider
      value={{
        settings,
        setAccentColor,
        setPortalName,
        setPortalSubtitle,
        setPortalEmoji,
        setPortalIcon,
        setIconBgHidden,
        setEmojiOnly,
        setOperatorName,
        setLanguage,
        setEmployeeOverride,
        clearEmployeeOverride,
        getEmployeeDisplay,
        resetAll,
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)

/** Keeps document.title in sync with the portal name setting. */
export function DocumentTitle() {
  const { settings } = useSettings()
  const nameRef = useRef(settings.portalName)
  nameRef.current = settings.portalName

  useEffect(() => {
    function applyTitle() {
      const name = nameRef.current || 'Jinn'
      const desired = `${name} - AI Gateway`
      if (document.title !== desired) {
        document.title = desired
      }
    }

    applyTitle()

    // Next.js metadata system can override document.title after hydration.
    // Watch for external changes and re-assert the correct title.
    const titleEl = document.querySelector('title')
    if (!titleEl) return

    const observer = new MutationObserver(() => applyTitle())
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [settings.portalName])

  return null
}
