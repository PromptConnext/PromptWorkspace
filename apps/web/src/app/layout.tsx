import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider } from "@/lib/workspace";
import "./globals.css";

export const metadata: Metadata = {
  title: "PromptConnext",
  description: "PromptConnext collaborative web workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <AuthProvider>
          <WorkspaceProvider>{children}</WorkspaceProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
