"use client"

import Avatar from "boring-avatars"
import { useSettings } from "@/app/settings-provider"

export const AVATAR_VARIANTS = [
  "beam",
  "marble",
  "pixel",
  "sunset",
  "bauhaus",
  "ring",
] as const

export type AvatarVariant = (typeof AVATAR_VARIANTS)[number]

const DEFAULT_COLORS = ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"]

interface EmployeeAvatarProps {
  name: string
  size?: number
  variant?: AvatarVariant
  colors?: string[]
  className?: string
  onClick?: () => void
}

export function EmployeeAvatar({
  name,
  size = 32,
  variant,
  colors,
  className,
  onClick,
}: EmployeeAvatarProps) {
  const { settings } = useSettings()
  const override = settings.employeeOverrides[name]
  const resolvedVariant = variant ?? (override?.avatarVariant as AvatarVariant) ?? "beam"
  const resolvedColors = colors ?? override?.avatarColors ?? DEFAULT_COLORS

  return (
    <span
      className={className}
      onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", overflow: "hidden", flexShrink: 0, width: size, height: size, cursor: onClick ? "pointer" : undefined }}
    >
      <Avatar
        name={name}
        size={size}
        variant={resolvedVariant}
        colors={resolvedColors}
      />
    </span>
  )
}

/** Standalone avatar preview without settings context (for pickers) */
export function AvatarPreview({
  name,
  size = 32,
  variant = "beam",
  colors = DEFAULT_COLORS,
  className,
  onClick,
}: EmployeeAvatarProps) {
  return (
    <span
      className={className}
      onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", overflow: "hidden", flexShrink: 0, width: size, height: size, cursor: onClick ? "pointer" : undefined }}
    >
      <Avatar
        name={name}
        size={size}
        variant={variant}
        colors={colors}
      />
    </span>
  )
}
