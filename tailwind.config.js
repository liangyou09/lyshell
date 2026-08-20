/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/**/*.{ts,tsx,html}',
  ],
  theme: {
    extend: {
      colors: {
        // 自定义颜色
        'bg-primary': '#1E1E1E',
        'bg-secondary': '#252526',
        'bg-card': '#2D2D30',
        'bg-input': '#3C3C3C',
        'bg-selected': '#264F78',
        'accent': '#0078D4',
        'accent-hover': '#006CBD',
      },
      fontFamily: {
        terminal: ['Lucida Console', 'Consolas', 'Courier New', 'monospace'],
      },
      animation: {
        'slide-in': 'slide-in 0.25s ease-out',
        'slide-out': 'slide-out 0.2s ease-in forwards',
        'pulse': 'pulse 0.6s ease infinite',
      },
    },
  },
  plugins: [],
}