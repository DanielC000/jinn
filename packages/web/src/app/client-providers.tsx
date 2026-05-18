
import type { ReactNode } from "react"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { ThemeProvider } from "@/app/providers"
import { SettingsProvider, DocumentTitle } from "@/app/settings-provider"
import { NotificationProvider } from "@/components/notifications/notification-provider"
import { useQueryInvalidation } from '@/hooks/use-query-invalidation'
import { BreadcrumbProvider } from '@/context/breadcrumb-context'
import { EmojiFavicon } from '@/components/emoji-favicon'
import { GatewayProvider } from '@/hooks/use-gateway'

function QueryInvalidationBridge() {
  useQueryInvalidation()
  return null
}

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BreadcrumbProvider>
          <SettingsProvider>
            <GatewayProvider>
              <NotificationProvider>
                {children}
                <DocumentTitle />
                <EmojiFavicon />
                <QueryInvalidationBridge />
              </NotificationProvider>
            </GatewayProvider>
          </SettingsProvider>
        </BreadcrumbProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
