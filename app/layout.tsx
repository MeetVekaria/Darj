import type { Metadata } from 'next';
import './globals.css';

const SITE_ORIGIN = 'https://darj-filing-reliability.meetveekaria.chatgpt.site';
const SOCIAL_IMAGE = `${SITE_ORIGIN}/og.png`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: 'DARJ: MCA21 Filing Reliability',
  description:
    'An independent prototype for reliable MCA21 AOC-4 filing journeys. Demo data only. Not affiliated with MCA.',
  openGraph: {
    title: 'DARJ: MCA21 Filing Reliability',
    description: 'Independent MCA21 filing prototype. Demo data only. Not affiliated with MCA.',
    images: [{ url: SOCIAL_IMAGE, width: 1200, height: 630, alt: 'DARJ MCA21 filing reliability prototype' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DARJ: MCA21 Filing Reliability',
    description: 'Independent MCA21 filing prototype. Demo data only. Not affiliated with MCA.',
    images: [SOCIAL_IMAGE],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
