import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Wisdom', description: 'Live view of recorded coding-agent sessions' };

const themeScript = `(function(){var t;try{t=localStorage.getItem('wisdom-theme')}catch(e){}
if(t!=='light'&&t!=='dark'&&t!=='night'){t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
document.documentElement.dataset.theme=t;var z;try{z=localStorage.getItem('wisdom-scale')}catch(e){}
if(z!=='1'&&z!=='1.25'&&z!=='1.5'){z='1.5'}document.documentElement.dataset.scale=z})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set theme and UI scale before first paint, so neither flashes the wrong way. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
