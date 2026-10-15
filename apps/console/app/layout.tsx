import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { THEME_BOOTSTRAP_SCRIPT } from '../components/ui/theme-toggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'OVO — Voice operations',
  description: 'Configure, release, test, and inspect OVO voice agents.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Reads the stored theme preference before paint so there is no flash of the wrong
            theme; the default (no stored preference) is `prefers-color-scheme`, handled in CSS. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
