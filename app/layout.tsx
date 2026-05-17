import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Secure P2P WebRTC',
  description: 'A pure WebRTC 1v1 calling app',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">
        {children}
      </body>
    </html>
  );
}
