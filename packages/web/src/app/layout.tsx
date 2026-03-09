import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Jinn — AI Gateway",
  description: "AI Gateway Dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>
        {children}
      </body>
    </html>
  )
}
