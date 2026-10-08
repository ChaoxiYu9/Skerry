# Skerry Native WinUI Migration Report

Date: 2026-08-15
Owner: Codex
Scope: remove the WebView2 UI runtime and rebuild Skerry as a native Windows UI while preserving the current product shape, data, and behavior.

## Backup

The current source-only backup is already in place:

    E:\galgame\Codex_xm\Wangy\source-backups\WangyManager-source-20260815-115459

Backup contents were intentionally limited to source and small project assets. Build outputs, dependency folders, caches, logs, and large tool folders were excluded.

## Skill Review

Applied interface-design review rules before touching the migration code:

- Use the existing product structure instead of inventing a new layout.
- Keep one focal action per view: home focus card, library card grid, detail action band, download queue.
- Replace browser layout and GSAP motion with native WinUI surfaces, shadows, focus states, and Composition animations.
- Build the visual system with semantic tokens, not page-level one-off colors.
- Use native controls first: NavigationView, ItemsRepeater, ScrollViewer, MenuFlyout, dialogs, AppWindow, Mica, and Acrylic.
- Keep primary page transitions calm. Stronger motion belongs to card/detail expansion, menus, buttons, and contextual panels.

## ReinaManager Findings

ReinaManager is the real Skerry business baseline. It uses the same core direction as current Skerry:

- Tauri 2 shell
- React + Vite + MUI frontend
- Rust backend
- SeaORM + SQLite
- Rust modules for database, game launch, play-time tracking, savedata backup, collections, install/download tasks, OAuth, and file helpers
- React Virtuoso for card grid virtualization

Current Skerry keeps this lineage and adds Skerry-specific UI polish, PotatoVN import, downloader changes, cover/banner handling, and extra cache/warmup work. Therefore the native migration should preserve the Reina/Skerry Rust service layer instead of rewriting all backend behavior in C#.

## PotatoVN Findings

PotatoVN is useful as the native-performance reference, not as the Skerry business baseline. It uses:

- WinUI 3 / XAML / C# on .NET 8 Windows
- Windows App SDK
- Microsoft.UI.Xaml controls
- NavigationView shell
- ItemsRepeater for dense card surfaces
- WinUI Composition and CommunityToolkit animations
- Mica, Acrylic, and custom transparent glass helpers

This explains why PotatoVN scrolls and recovers focus more smoothly: card rendering, virtualization, compositor animations, and window materials stay inside the Windows native UI stack instead of WebView2.

## Current Skerry Findings

Skerry is currently a Tauri app:

- React + Vite + MUI + GSAP frontend
- Tauri 2 shell on Windows
- Rust backend with SeaORM + SQLite and many Tauri commands
- Production package loads built frontend assets, not the Vite dev server
- Windows UI still runs inside WebView2 because that is Tauri's Windows webview runtime

The existing Rust backend has roughly 77 Tauri command endpoints covering games, settings, launch, play time, savedata, downloads, imports, covers, OAuth, and maintenance. Rewriting all of that into C# immediately would be slow and risky.

## Migration Architecture

Recommended route: native WinUI frontend plus retained Rust business service.

    Skerry.Native WinUI app
      -> C# view models and native controls
      -> Named Pipe JSON IPC client
      -> Skerry Rust local service
      -> existing SQLite/database/game/download/sync logic

Why this route:

- It fully removes WebView2 from the UI.
- It keeps existing data and backend behavior intact during migration.
- It allows page-by-page replacement while the current Tauri app remains a visual and functional reference.
- It lets the slow surfaces move first: game-library grids, collection grids, home panels, and detail cards.

## Phase Plan

| Phase | Goal | Status |
| --- | --- | --- |
| 0 | Source-only backup and project review | Done |
| 1 | Create native WinUI app shell, theme tokens, card grid, and motion helpers | Done |
| 2 | Extract Rust service boundary from Tauri commands into reusable service handlers | Done |
| 3 | Add Named Pipe JSON IPC between WinUI and Rust service | Done |
| 4 | Rebuild home and game library with native virtualization | Done |
| 5 | Rebuild game detail open/close animation and contextual cards | Done |
| 6 | Rebuild collection, downloads, settings, annual report, dialogs, and right-click menus | Done |
| 7 | Package native app, test long-idle focus recovery, scroll performance, and data compatibility | Verified; ongoing regression coverage |

## Native UI Rules

- Layout must preserve the current Skerry information architecture unless a specific issue requires otherwise.
- No GSAP in the native app. Equivalent motion should use WinUI Composition, Storyboard, ConnectedAnimation, and Visual Layer animations.
- Card grids should use ItemsRepeater or native virtualized collection controls, not manual full-list rendering.
- Image loading must decode at target size and avoid layout-triggering late swaps.
- Long-idle focus recovery must avoid destroying and recreating primary pages.
- Primary pages should remain mounted where practical; secondary/detail pages can use lightweight prewarm.
- Context menus and flyouts must use native MenuFlyout or Flyout with consistent width, dark-mode contrast, and destructive icon coloring.

## Acceptance Checks

- The native shell launches without WebView2.
- Library scrolling remains smooth with hundreds of cards.
- Sorting and free-drag modes do not create duplicate scrollbars or window width jitter.
- Returning to the app after idle does not freeze the UI thread.
- Card detail open and close animations remain natural, with no white flash or delayed banner shrink.
- Existing user data remains readable through the Rust service.
- Current Tauri source stays buildable until the native app fully replaces it.

## Work Log

- Confirmed source-only backup exists and is valid.
- Confirmed ReinaManager is the Skerry business/data baseline.
- Confirmed PotatoVN is the WinUI performance/material reference.
- Confirmed Skerry's current WebView2 dependency comes from Tauri, not the dev server.
- Started native/Skerry.Native as the new WinUI 3 migration target.
- Added src-tauri/src/native_ipc.rs and src-tauri/src/bin/skerry-native-service.rs.
- Implemented first native IPC methods: ping, appInfo, and games.list.
- Reused the existing SeaORM repositories and migrations instead of duplicating database logic in C#.
- Updated Skerry.Native library page to load real game cards through the named pipe, with sample data only as fallback.
- Extended native game cards with local cover/banner URIs from the existing covers/game_{id} folder.
- Verified cargo build --bin skerry-native-service succeeds.
- Verified dotnet build native/Skerry.Native/Skerry.Native.csproj -p:Platform=x64 succeeds.
- Verified games.list returns real local data and media paths, including titles like 暁の護衛 and file-backed cover URIs.
- Added games.detail, collections.overview, collections.categories, collections.developers IPC methods.
- Added DownloadsPage native route with real embedded download and install-task queue snapshots.
- Added settings.get IPC and SettingsPage native route for storage paths, account state, VNDB, and tool paths.
- Added report.annual IPC and ReportPage native route for total time, played games, active days, streak, monthly/weekday distribution, and top games.
- Reverified cargo build --bin skerry-native-service and dotnet build native/Skerry.Native/Skerry.Native.csproj -p:Platform=x64 --no-restore both succeed after the new routes.
- Smoke-tested IPC methods: collections.overview, collections.developers, games.list, games.detail, downloads.list, settings.get, and report.annual.
- Added native mutating workflows for game create/update/delete, scan/import, collection create/update/delete and membership, download creation/control, settings update/import, savedata create/restore/delete, database and cover backups, and launch/stop/runtime tracking.
- Added native WinUI pages for Home, Library, Game Detail, Collection, Downloads, Annual Report, and Settings with loading, empty, error, action, and confirmation states.
- Added native motion helpers and applied mount/detail/toolbar animations without React or GSAP in the native project.
- Added automatic native-service startup from the application directory with debug/release development fallbacks.
- Added scripts/build-native.ps1 and scripts/smoke-native-ipc.ps1; both validate the native executable, service, 7zip tool, and absence of WebView2 runtime artifacts in the output directory.
- Verified native Debug and Release builds produce Skerry.Native.exe, skerry-native-service.exe, and 7zip/7z.exe with zero WinUI compiler errors.
- Verified Rust native-service unit tests: 52 passed, 0 failed.
- Verified Release named-pipe smoke: ping, appInfo, and real games.list returned successfully, including local file-backed cover/banner URIs.
- Added a Home featured-card detail entry so every primary game surface can reach Game Detail.
- Diagnosed the first native launch failure: the Windows App SDK automatic bootstrap selected an incompatible installed runtime before managed Program.Main ran. Switched the WinUI app to a self-contained Windows App SDK output and kept the custom Program.Main entry so the app starts deterministically.
- Diagnosed and fixed the first post-launch UI failure: WinUI binding tried to convert backend file-path strings directly into Image.Source. Native models and view models now create BitmapImage/ImageSource values explicitly.
- Reduced startup logging to durable launch milestones and exception diagnostics, and added scripts/smoke-native-ui.ps1 to verify the app, Rust service, named pipe, appInfo, real game data, and current-run logs together.

## Current Native Slice

The current native prototype is no longer a pure mock. The WinUI game library can now request real Skerry game data from the Rust service through \\.\pipe\skerry-native-ipc.

Included fields in the first slice:

- id
- title
- developer
- status
- play hours
- accent index
- custom cover key
- banner key
- resolved image URI
- resolved banner URI

The native replacement slice now includes real game library data, game detail data, collection/developer categories, download queues, editable settings, annual-report statistics, game mutation, launch/stop tracking, savedata management, database/cover maintenance, and native packaging. The old React/Vite/Tauri source remains in the repository as the compatibility/reference path, but the native executable does not load it and communicates with Rust only through the named pipe.

## Verified Native Commands

From the project root:

    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-native.ps1 -Configuration Release
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/smoke-native-ipc.ps1 -Configuration Release
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/smoke-native-ui.ps1 -Configuration Release
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/run-native.ps1 -Configuration Release

The first command builds only the Rust native service and WinUI app. The second starts the service, checks the named pipe, queries real data, and stops the service. The third starts the native WinUI app and verifies that HomePage reaches its loaded state while the Rust service and pipe are usable. The fourth starts the native WinUI executable; none of these native commands starts Vite, React, or Tauri.
