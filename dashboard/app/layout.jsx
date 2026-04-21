import './globals.css';

export const metadata = {
  title: 'LUSI Rover AI Agent',
  description: 'AI knowledge base and assistant for the Lehigh University Space Initiative.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
