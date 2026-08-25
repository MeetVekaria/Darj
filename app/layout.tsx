import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DARJ: MCA21 Filing Reliability',
  description:
    'An independent prototype for reliable MCA21 AOC-4 filing journeys. Demo data only. Not affiliated with MCA.',
  openGraph: {
    title: 'DARJ: MCA21 Filing Reliability',
    description: 'Independent MCA21 filing prototype. Demo data only. Not affiliated with MCA.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'DARJ MCA21 filing reliability prototype' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DARJ: MCA21 Filing Reliability',
    description: 'Independent MCA21 filing prototype. Demo data only. Not affiliated with MCA.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
