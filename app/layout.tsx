import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "hr-onboard — Terminal 3 agent",
  description:
    "Privacy-preserving employee onboarding on Terminal 3. The agent plans on non-sensitive data; a TEE contract acts; employee PII is resolved host-side inside the enclave.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
