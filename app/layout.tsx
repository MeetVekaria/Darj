import type { Metadata } from 'next';
import './globals.css';

const SITE_ORIGIN = 'https://darj-filing-reliability.meetveekaria.chatgpt.site';
const SOCIAL_IMAGE = `${SITE_ORIGIN}/og.png`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: 'DARJ: MCA21 Filing Reliability',
  description:
    'An independent corporate filing workspace with one complete MCA21 AOC-4 reliability journey. Demo data only. Not affiliated with MCA.',
  openGraph: {
    title: 'DARJ: MCA21 Filing Reliability',
    description: 'Independent corporate filing prototype with one complete MCA21 AOC-4 reliability journey. Demo data only. Not affiliated with MCA.',
    images: [{ url: SOCIAL_IMAGE, width: 1200, height: 630, alt: 'DARJ MCA21 filing reliability prototype' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DARJ: MCA21 Filing Reliability',
    description: 'Independent corporate filing prototype with one complete MCA21 AOC-4 reliability journey. Demo data only. Not affiliated with MCA.',
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
