/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        arcium: '#7b61ff',
        'arcium-dim': 'rgba(123,97,255,0.1)',
        teal: '#00ffd1',
        'bg0': '#04060a',
        'bg1': '#080c12',
        'bg2': '#0d1219',
      },
      fontFamily: {
        mono: ['DM Mono', 'monospace'],
        display: ['Clash Display', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
