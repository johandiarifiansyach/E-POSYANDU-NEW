/** @type {import('tailwindcss').Config} */
export default {
  // Keep the production scan broad enough for React TSX, shared compatibility
  // helpers, and the static maintenance fallback. Tailwind removes every
  // utility not found in these sources during the production build.
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
    './public/**/*.html'
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', 'Arial', 'sans-serif']
      }
    }
  },
  plugins: []
};
