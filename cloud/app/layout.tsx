import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Re:Nrob Lab · 訂單管理',
  description: 'Re:Nrob Lab 訂單與製作進度管理',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-Hant"><head><link rel="stylesheet" href="/style.css" /></head><body>{children}</body></html>;
}
