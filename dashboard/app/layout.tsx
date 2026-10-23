import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Wisdom', description: 'Live view of recorded coding-agent sessions' };

const themeScript = `(function(){var t;try{t=localStorage.getItem('wisdom-theme')}catch(e){}
if(t!=='light'&&t!=='dark'&&t!=='night'){t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
document.documentElement.dataset.theme=t})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme before first paint, so a dark choice never flashes light. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
