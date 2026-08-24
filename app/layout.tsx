import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DARJ · A filing should survive the browser',
  description:
    'An independent filing-reliability prototype for a durable, retry-safe synthetic AOC-4 journey.',
  openGraph: {
    title: 'DARJ · A filing should survive the browser',
    description: 'Independent prototype · Synthetic data · Not an MCA service',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'DARJ filing reliability prototype' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DARJ · A filing should survive the browser',
    description: 'Independent prototype · Synthetic data · Not an MCA service',
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
