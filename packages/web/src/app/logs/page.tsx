"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw, Radio } from "lucide-react"
import { api } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { LogBrowser, parseLogLine } from "@/components/activity/log-browser"

/* ── Summary Cards ─────────────────────────────────────────────── */

function SummaryCard({
  label,
  value,
  color,
  pulse,
}: {
  label: string
  value: number
  color?: string
  pulse?: boolean
}) {
  return (
    <div
      style={{
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-4)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-caption1)",
          color: "var(--text-tertiary)",
          fontWeight: "var(--weight-medium)",
          marginBottom: "var(--space-1)",
        }}
      >
        {label}
      </div>
      <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
        {pulse && value > 0 && (
          <span
            className="animate-error-pulse"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--system-red)",
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: "var(--text-title2)",
            fontWeight: "var(--weight-bold)",
            color: color ?? "var(--text-primary)",
          }}
        >
          {value}
        </span>
      </div>
    </div>
  )
}

/* ── Page ──────────────────────────────────────────────────────── */

export default function LogsPage() {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [updatedAgo, setUpdatedAgo] = useState("just now")

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .getLogs(500)
      .then((data) => {
        setLines(data.lines ?? [])
        setLastRefresh(new Date())
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load logs")
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  // Initial load + auto-refresh every 30s
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  // Updated ago ticker
  useEffect(() => {
    function tick() {
      const diff = Date.now() - lastRefresh.getTime()
      const secs = Math.floor(diff / 1000)
      if (secs < 10) setUpdatedAgo("just now")
      else if (secs < 60) setUpdatedAgo(`${secs}s ago`)
      else setUpdatedAgo(`${Math.floor(secs / 60)}m ago`)
    }
    tick()
    const interval = setInterval(tick, 10000)
    return () => clearInterval(interval)
  }, [lastRefresh])

  // Parse lines for summary counts
  const entries = lines.map(parseLogLine)
  const totalCount = entries.length
  const errorCount = entries.filter((e) => e.level === "error").length
  const infoCount = entries.filter((e) => e.level === "info").length
  const warnCount = entries.filter((e) => e.level === "warn").length

  return (
    <PageLayout>
      <div
        className="h-full flex flex-col overflow-hidden animate-fade-in"
        style={{ background: "var(--bg)" }}
      >
        {/* Sticky header */}
        <header
          className="sticky top-0 z-10 flex-shrink-0"
          style={{
            background: "var(--material-regular)",
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
            borderBottom: "1px solid var(--separator)",
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: "var(--space-4) var(--space-6)" }}
          >
            <div>
              <h1
                style={{
                  fontSize: "var(--text-title1)",
                  fontWeight: "var(--weight-bold)",
                  color: "var(--text-primary)",
                  letterSpacing: "-0.5px",
                  lineHeight: "var(--leading-tight)",
                }}
              >
                Activity Console
              </h1>
              {!loading && (
                <p
                  style={{
                    fontSize: "var(--text-footnote)",
                    color: "var(--text-secondary)",
                    marginTop: "var(--space-1)",
                  }}
                >
                  {totalCount} event{totalCount !== 1 ? "s" : ""}
                  {errorCount > 0 && (
                    <span style={{ color: "var(--system-red)" }}>
                      {" \u00b7 "}
                      {errorCount} error{errorCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </p>
              )}
            </div>
            <div
              className="flex items-center"
              style={{ gap: "var(--space-3)" }}
            >
              {/* Open Live Stream */}
              <button
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("open-live-stream"))
                }
                className="focus-ring flex items-center"
                style={{
                  padding: "6px 14px",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-footnote)",
                  fontWeight: "var(--weight-semibold)",
                  gap: 6,
                  background: "var(--accent-fill)",
                  color: "var(--accent)",
                  transition: "all 200ms var(--ease-smooth)",
                }}
              >
                <Radio size={14} />
                Open Live Stream
              </button>

              <span
                style={{
                  fontSize: "var(--text-caption1)",
                  color: "var(--text-tertiary)",
                }}
              >
                Updated {updatedAgo}
              </span>
              <button
                onClick={refresh}
                className="focus-ring"
                aria-label="Refresh logs"
                style={{
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-tertiary)",
                  cursor: "pointer",
                  transition: "color 150ms var(--ease-smooth)",
                }}
              >
                <RefreshCw
                  size={16}
                  className={refreshing ? "animate-spin" : ""}
                />
              </button>
            </div>
          </div>
        </header>

        {/* Scrollable content */}
        <div
          className="flex-1 overflow-y-auto flex flex-col"
          style={{
            padding: "var(--space-4) var(--space-6) var(--space-6)",
            minHeight: 0,
          }}
        >
          {/* Error banner */}
          {error && (
            <div
              style={{
                marginBottom: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "rgba(255,69,58,0.06)",
                border: "1px solid rgba(255,69,58,0.15)",
                fontSize: "var(--text-footnote)",
                color: "var(--system-red)",
              }}
            >
              Failed to load logs: {error}
            </div>
          )}

          {loading ? (
            <div
              className="flex items-center justify-center"
              style={{ height: 200, color: "var(--text-tertiary)" }}
            >
              Loading...
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div
                className="summary-cards-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: "var(--space-3)",
                  marginBottom: "var(--space-4)",
                }}
              >
                <SummaryCard label="Total Events" value={totalCount} />
                <SummaryCard
                  label="Errors"
                  value={errorCount}
                  color={
                    errorCount > 0
                      ? "var(--system-red)"
                      : "var(--system-green)"
                  }
                  pulse
                />
                <SummaryCard
                  label="Info"
                  value={infoCount}
                  color="var(--system-green)"
                />
                <SummaryCard
                  label="Warnings"
                  value={warnCount}
                  color="var(--system-orange)"
                />
              </div>

              {/* Log browser */}
              <LogBrowser lines={lines} />
            </>
          )}
        </div>

        <style>{`
          @media (max-width: 640px) {
            .summary-cards-grid {
              grid-template-columns: 1fr 1fr !important;
            }
          }
        `}</style>
      </div>
    </PageLayout>
  )
}
