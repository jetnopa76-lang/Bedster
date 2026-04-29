import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import StickersPage from './Stickers.jsx'

// Simple hash-based routing — no react-router needed
const path = window.location.pathname;
const isStickers = path === '/stickers' || path.startsWith('/stickers');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isStickers ? <StickersPage /> : <App />}
  </React.StrictMode>,
)
