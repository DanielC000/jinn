
import { lazy, Suspense, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { useSettings } from "@/app/settings-provider"
import { Sidebar } from "./sidebar"
import { NotificationBell } from "./notifications/notification-bell"
import { BreadcrumbBar } from "./breadcrumb-bar"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { Menu, X } from "lucide-react"
import { NAV_ITEMS } from "@/lib/nav"
import { cn } from "@/lib/utils"

const GlobalSearch = lazy(() => import("./global-search").then(m => ({ default: m.GlobalSearch })))
const LiveStreamWidget = lazy(() => import("./live-stream-widget").then(m => ({ default: m.LiveStreamWidget })))
const OnboardingWizard = lazy(() => import("./onboarding-wizard").then(m => ({ default: m.OnboardingWizard })))

function MobileHeader({ actions }: { actions?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const pathname = useLocation().pathname
  const { settings } = useSettings()
  const emoji = settings.portalEmoji ?? "\u{1F9DE}"
  const portalName = settings.portalName ?? "Jinn"

  return (
    <>
      <div className="relative z-60 flex h-12 shrink-0 items-center border-b border-border bg-[var(--material-thick)] px-3 lg:hidden">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="inline-flex size-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent"
        >
          <Menu size={20} />
        </button>
        <div className="flex flex-1 items-center justify-center text-center">
          <span className="mr-1.5 text-lg">{emoji}</span>
          <span className="text-sm font-semibold text-foreground">{portalName}</span>
        </div>
        <div className="flex items-center gap-1">
          {actions}
          <NotificationBell />
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-[120] lg:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={() => setOpen(false)} />
          <nav className="absolute inset-y-0 left-0 flex w-[260px] animate-slide-in flex-col border-r border-border bg-[var(--bg-secondary)]">
            <div className="flex items-center justify-between border-b border-border px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[22px]">{emoji}</span>
                <span className="text-base font-semibold text-foreground">{portalName}</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-1 p-2">
              {NAV_ITEMS.map((item) => {
                const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex h-11 items-center gap-3 rounded-[10px] px-3.5 text-[15px] transition-colors",
                      isActive
                        ? "bg-[var(--accent-fill)] font-semibold text-[var(--accent)]"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <Icon size={18} className="shrink-0" />
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </nav>
        </div>
      )}

      {/* CSS animation */}
      <style>{`
        @keyframes slideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </>
  )
}

export function ToolbarActions({ children }: { children?: React.ReactNode }) {
  return (
    <div className="hidden items-center gap-2 lg:flex">
      {children}
      <NotificationBell />
    </div>
  )
}

function DesktopHeader() {
  const { items } = useBreadcrumbs()
  if (items.length === 0) return null
  return (
    <div className="hidden h-12 shrink-0 items-center border-b border-border bg-[var(--material-thick)] px-5 lg:flex">
      <BreadcrumbBar />
    </div>
  )
}

export function PageLayout({ children, mobileHeaderActions }: { children: React.ReactNode; mobileHeaderActions?: React.ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar />
      <Suspense fallback={null}>
        <GlobalSearch />
      </Suspense>
      <main className="flex-1 overflow-hidden flex flex-col lg:ml-[56px]">
        <MobileHeader actions={mobileHeaderActions} />
        <DesktopHeader />
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </main>
      <Suspense fallback={null}>
        <LiveStreamWidget />
      </Suspense>
      <Suspense fallback={null}>
        <OnboardingWizard />
      </Suspense>
    </div>
  )
}
