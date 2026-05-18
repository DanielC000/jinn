"use client"

import { useState, useMemo, useRef, useEffect } from "react"
import { EMOJI_POOL } from "@/lib/emoji-pool"

interface EmojiPickerProps {
  current: string
  onSelect: (emoji: string) => void
  onClose: () => void
}

interface EmojiEntry {
  emoji: string
  keywords: string[]
}

export function EmojiPicker({ current, onSelect, onClose }: EmojiPickerProps) {
  const [search, setSearch] = useState("")
  const [emojis, setEmojis] = useState<EmojiEntry[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Lazy-load emojilib only when picker is open (i.e., mounted)
  useEffect(() => {
    let cancelled = false
    import("emojilib").then((mod) => {
      if (cancelled) return
      const data = (mod.default ?? mod) as Record<string, string[]>
      const list = Object.entries(data).map(([emoji, keywords]) => ({ emoji, keywords }))
      setEmojis(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return null
    const results: Array<{ emoji: string; label: string }> = []
    for (const entry of (emojis ?? [])) {
      if (entry.keywords.some((kw) => kw.includes(q))) {
        results.push({ emoji: entry.emoji, label: entry.keywords[0] })
        if (results.length >= 80) break
      }
    }
    return results
  }, [search, emojis])

  return (
    <div
      ref={containerRef}
      className="absolute top-full left-0 z-50 mt-2 rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-thick)] p-3 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
      style={{ width: 320 }}
    >
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search emojis (gym, happy, food...)"
        className="mb-2 w-full rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
      />

      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {filtered === null ? (
          <>
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-1.5">
              Suggested
            </p>
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_POOL.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => onSelect(emoji)}
                  className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1.5 text-xl transition-colors ${emoji === current ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </>
        ) : emojis === null ? (
          <div className="grid grid-cols-8 gap-1 opacity-30">
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className="h-9 rounded-[var(--radius-md,12px)] bg-[var(--fill-secondary)]" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-center text-xs text-[var(--text-tertiary)]">
            No emojis found for &ldquo;{search}&rdquo;
          </p>
        ) : (
          <>
            <p className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-1.5">
              {filtered.length >= 80 ? "80+" : filtered.length} results
            </p>
            <div className="grid grid-cols-8 gap-1">
              {filtered.map((e) => (
                <button
                  key={e.emoji}
                  onClick={() => onSelect(e.emoji)}
                  title={e.label}
                  className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1.5 text-xl transition-colors ${e.emoji === current ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                >
                  {e.emoji}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
