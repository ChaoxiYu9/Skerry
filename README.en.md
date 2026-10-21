# Skerry

> A modern desktop workspace for visual novel libraries, metadata updates, play tracking, yearly statistics, and quotes.

Skerry is an independently maintained visual novel library manager and launcher by ChaoxiYu9. It helps organize a local library, maintain game information, and track play history.

> **Long-term goal**  
> Progressively rewrite the frontend and backend in-house, move beyond the web-wrapper form, and ultimately become an independent product that no longer builds on or extends other projects' code.

Repository: [ChaoxiYu9/Skerry](https://github.com/ChaoxiYu9/Skerry)  
简体中文：[README.md](README.md)

## Features

- Organize a local visual novel library, launchers, and game information.
- Search and update metadata from multiple sources, add games individually, import in batches, and import cloud collections.
- Manage covers, detail-page backgrounds, and CG galleries.
- Track play status and play time with calendar views, statistics, and yearly rankings.
- Keep local and cloud reviews as separate records, with optional review synchronization.
- Use quotes, a planning list, and a random-game feature.
- Switch between light and dark themes.
- Import local game information, source IDs, covers, and play history from PotatoVN exports.

## Screenshots

### Home

![Skerry home dashboard with library overview, monthly calendar, and recent activity](截图/home-dashboard.png)

### Library

![Skerry game library](截图/game-library.png)

### Game details

![Skerry game details and metadata](截图/game-detail-overview.png)

### Statistics and reviews

![Game statistics](截图/game-detail-statistics.png)

![Separate local and cloud review cards](截图/game-reviews-cloud-sync.png)

### Annual summary

![Skerry annual summary](截图/annual-summary.png)

## Run from source

### Requirements

- Node.js and pnpm (the project pins pnpm 11.11.0)
- Rust toolchain (the current Tauri configuration requires Rust 1.97.1)
- Tauri build dependencies for your operating system

### Install and build

    pnpm install
    pnpm tauri dev

Build the frontend:

    pnpm build

Build the desktop installer:

    pnpm tauri build

## Tests

The `tests/` directory contains Node.js regression-test sources. The current `package.json` does not define a unified `pnpm test` script.

## License and code origin

Skerry is distributed under GNU AGPL v3; see the repository root [LICENSE](LICENSE). Parts of the code are based on and adapted from [ReinaManager](https://github.com/huoshen80/ReinaManager). Skerry is independently maintained by ChaoxiYu9. See [CHANGELOG.md](CHANGELOG.md) for the changelog.
