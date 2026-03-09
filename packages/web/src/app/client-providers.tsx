"use client"

import type { ReactNode } from "react"
import { ThemeProvider } from "@/app/providers"
import { SettingsProvider, DocumentTitle } from "@/app/settings-provider"

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        {children}
        <DocumentTitle />
      </SettingsProvider>
    </ThemeProvider>
  )
}
