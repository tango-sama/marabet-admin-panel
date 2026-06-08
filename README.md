# Bazar Merabet — Admin Panel

Dark-themed admin panel for managing a shoe & bag store. Single-file, zero dependencies.

## Features

- **Product management** — add, edit, duplicate, delete products with inline editing
- **Photo & color variants** — upload product photos, assign colors via preset swatches or custom hex
- **Categories** — manage product categories with photo thumbnails
- **Orders dashboard** — view and fulfill customer orders via Yalidine delivery API
- **WhatsApp integration** — one-click reply to customers
- **Settings** — store info, Yalidine API credentials, Algeria wilayas
- **Import/Export** — JSON backup and restore
- **Keyboard shortcuts** — `Ctrl+S` save, `Ctrl+B` toggle sidebar, `Ctrl+N` new row, `ESC` close
- **Pagination** — handles hundreds of products smoothly (25 per page)
- **Persistent storage** — IndexedDB for photos, localStorage for structured data

## Tech

- Pure HTML/CSS/JavaScript — no frameworks, no build step
- Works offline, opens directly in any modern browser
- Dark theme with gold accents, Arabic-ready typography (Cairo + Amiri)

## Quick Start

1. Open `admin_panel.html` in any browser
2. Start adding products

That's it. All data stays in your browser's localStorage and IndexedDB.

## Backup

Use the **Export** button to download a full JSON backup including products, categories, and settings. Use **Import** to restore.

## Yalidine Setup

1. Go to [app.yalidine.app/dev](https://app.yalidine.app/dev)
2. Get your API ID and Token
3. Enter them in **Settings** along with your source Wilaya

## License

Proprietary — all rights reserved.
