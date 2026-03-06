"use client"

import { useState } from "react"

/* ── Types ───────────────────────────────────────────────────── */

export interface ParsedLogEntry {
  id: string
  timestamp: string
  level: string
  message: string
}

/* ── Helpers ──────────────────────────────────────────────────── */

const LEVEL_COLOR: Record<string, string> = {
  info: "var(--system-green)",
  warn: "var(--system-orange)",
  error: "var(--system-red)",
  debug: "var(--text-tertiary)",
}

const LEVEL_BG: Record<string, string> = {
  info: "rgba(48,209,88,0.12)",
  warn: "rgba(255,159,10,0.12)",
  error: "rgba(255,69,58,0.12)",
  debug: "var(--fill-secondary)",
}

type FilterKey = "all" | "info" | "warn" | "error"

const PILLS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "info", label: "Info" },
  { key: "warn", label: "Warn" },
  { key: "error", label: "Errors" },
]

export function parseLogLine(raw: string, index: number): ParsedLogEntry {
  // Expected format: "2026-03-07 12:00:00 [INFO] message here"
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*(.*)$/)
  if (match) {
    return {
      id: `log-${index}`,
      timestamp: match[1],
      level: match[2].toLowerCase(),
      message: match[3],
    }
  }
  // Fallback: treat entire line as message
  return {
    id: `log-${index}`,
    timestamp: "",
    level: "info",
    message: raw,
  }
}

/* ── Component ────────────────────────────────────────────────── */

interface LogBrowserProps {
  lines: string[]
}

export function LogBrowser({ lines }: LogBrowserProps) {
  const [filter, setFilter] = useState<FilterKey>("all")
  const [search, setSearch] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const entries = lines.map(parseLogLine)

  const filtered = entries.filter((e) => {
    if (filter !== "all" && e.level !== filter) return false
    if (search && !e.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const counts: Record<FilterKey, number> = {
    all: entries.length,
    info: entries.filter((e) => e.level === "info").length,
    warn: entries.filter((e) => e.level === "warn").length,
    error: entries.filter((e) => e.level === "error").length,
  }

  return (
    <div>
      {/* Filter pills + search */}
      <div
        className="flex items-center flex-wrap"
        style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}
      >
        {PILLS.map((pill) => {
          const isActive = filter === pill.key
          return (
            <button
              key={pill.key}
              onClick={() => setFilter(pill.key)}
              className="focus-ring flex items-center flex-shrink-0"
              style={{
                borderRadius: 20,
                padding: "6px 14px",
                fontSize: "var(--text-footnote)",
                fontWeight: "var(--weight-medium)",
                border: "none",
                cursor: "pointer",
                gap: "var(--space-2)",
                transition: "all 200ms var(--ease-smooth)",
                ...(isActive
                  ? {
                      background: "var(--accent-fill)",
                      color: "var(--accent)",
                      boxShadow:
                        "0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)",
                    }
                  : {
                      background: "var(--fill-secondary)",
                      color: "var(--text-primary)",
                    }),
              }}
            >
              <span>{pill.label}</span>
              <span
                style={{
                  fontWeight: "var(--weight-semibold)",
                  color: isActive ? "var(--accent)" : "var(--text-secondary)",
                }}
              >
                {counts[pill.key]}
              </span>
            </button>
          )
        })}

        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="focus-ring"
          style={{
            marginLeft: "auto",
            padding: "6px 12px",
            fontSize: "var(--text-footnote)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--separator)",
            background: "var(--fill-secondary)",
            color: "var(--text-primary)",
            outline: "none",
            minWidth: 160,
            maxWidth: 240,
          }}
        />
      </div>

      {/* Entry list */}
      {filtered.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center"
          style={{
            height: 200,
            color: "var(--text-secondary)",
            gap: "var(--space-2)",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-subheadline)",
              fontWeight: "var(--weight-medium)",
            }}
          >
            {entries.length === 0
              ? "No log entries found"
              : "No entries match this filter"}
          </span>
          <span
            style={{
              fontSize: "var(--text-footnote)",
              color: "var(--text-tertiary)",
            }}
          >
            {entries.length === 0
              ? "Log entries will appear here when available"
              : "Try adjusting your filter or search"}
          </span>
        </div>
      ) : (
        <div
          style={{
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
            background: "var(--material-regular)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
          }}
        >
          {filtered.map((entry, idx) => {
            const isExpanded = expandedId === entry.id
            const levelColor = LEVEL_COLOR[entry.level] ?? "var(--text-tertiary)"
            const isLong = entry.message.length > 120

            return (
              <div key={entry.id}>
                {idx > 0 && (
                  <div
                    style={{
                      height: 1,
                      background: "var(--separator)",
                      marginLeft: "var(--space-4)",
                      marginRight: "var(--space-4)",
                    }}
                  />
                )}

                {/* Row */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isLong ? isExpanded : undefined}
                  onClick={() => isLong && setExpandedId(isExpanded ? null : entry.id)}
                  onKeyDown={(e) => {
                    if (isLong && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault()
                      setExpandedId(isExpanded ? null : entry.id)
                    }
                  }}
                  className="flex items-center hover-bg focus-ring"
                  style={{
                    minHeight: 44,
                    padding: "0 var(--space-4)",
                    cursor: isLong ? "pointer" : "default",
                    background:
                      entry.level === "error"
                        ? "rgba(255,69,58,0.06)"
                        : undefined,
                  }}
                >
                  {/* Status dot */}
                  <span
                    className="flex-shrink-0 rounded-full"
                    style={{
                      width: 8,
                      height: 8,
                      background: levelColor,
                    }}
                  />

                  {/* Timestamp */}
                  {entry.timestamp && (
                    <span
                      className="flex-shrink-0 font-mono"
                      style={{
                        fontSize: "var(--text-caption1)",
                        color: "var(--text-tertiary)",
                        marginLeft: "var(--space-3)",
                        minWidth: 130,
                      }}
                    >
                      {entry.timestamp}
                    </span>
                  )}

                  {/* Level badge */}
                  <span
                    className="flex-shrink-0"
                    style={{
                      fontSize: "var(--text-caption2)",
                      fontWeight: "var(--weight-semibold)",
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: LEVEL_BG[entry.level] ?? "var(--fill-secondary)",
                      color: levelColor,
                      marginLeft: "var(--space-2)",
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                    }}
                  >
                    {entry.level}
                  </span>

                  {/* Message */}
                  <span
                    className="truncate"
                    style={{
                      fontSize: "var(--text-footnote)",
                      color: "var(--text-primary)",
                      marginLeft: "var(--space-3)",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {isLong && !isExpanded
                      ? entry.message.slice(0, 117) + "..."
                      : entry.message}
                  </span>

                  {/* Chevron for long messages */}
                  {isLong && (
                    <span
                      aria-hidden="true"
                      style={{
                        fontSize: "var(--text-footnote)",
                        color: "var(--text-tertiary)",
                        transition: "transform 200ms var(--ease-smooth)",
                        transform: isExpanded
                          ? "rotate(90deg)"
                          : "rotate(0deg)",
                        display: "inline-block",
                        marginLeft: "var(--space-2)",
                      }}
                    >
                      &#8250;
                    </span>
                  )}
                </div>

                {/* Expanded detail */}
                {isExpanded && isLong && (
                  <div
                    className="animate-slide-down"
                    style={{
                      padding: "0 var(--space-4) var(--space-4) var(--space-4)",
                    }}
                  >
                    <div
                      style={{
                        borderRadius: "var(--radius-sm)",
                        background: "var(--fill-secondary)",
                        padding: "var(--space-3)",
                        marginTop: "var(--space-2)",
                      }}
                    >
                      <pre
                        className="font-mono"
                        style={{
                          fontSize: "var(--text-caption2)",
                          color: "var(--text-secondary)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          margin: 0,
                          maxHeight: 300,
                          overflow: "auto",
                          lineHeight: "var(--leading-relaxed)",
                        }}
                      >
                        {entry.message}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
