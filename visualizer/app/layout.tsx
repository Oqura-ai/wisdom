import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';

export const metadata: Metadata = { title: 'Wisdom Commits', description: 'What landed on main and the branches, the commits behind it, and the recorded sessions behind those' };

// Fetched once at build time and served from the bundle: the page never reaches the internet for them.
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

const themeScript = `(function(){var t;try{t=localStorage.getItem('wisdom-theme')}catch(e){}
if(t!=='light'&&t!=='dark'&&t!=='night'){t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
document.documentElement.dataset.theme=t})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Set the theme before first paint, so it never flashes the wrong way. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
