# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-19

First release.

### Added

- Desktop app shell (Wails v3) with a frameless window, custom title bar, and
  drag regions.
- Stream resolution through multiple mirrors with automatic failover, numbered
  sub-servers, and a manual picker in the player.
- Built-in player (Vidstack + hls.js): subtitles with per-language styling,
  quality selection, skip intro/outro, auto-play/next/skip, and keyboard
  shortcuts including `Ctrl+S`/`Ctrl+D` server chords.
- Kuma: opt-in torrent streaming through a local BitTorrent client, published as
  a seekable VOD episode with a real duration; subtitle tracks from a subtitle
  addon; audio-track selection for dual-audio releases.
- Offline downloads with pause/resume, quality choice, and local playback.
- Bandwidth-aware quality selection driven by a periodic speed test that only
  runs during playback and can be paused from the title bar.
- Watch history with per-episode deletion, watch-later library, and a continue
  watching shelf on the home page.
- Account layer: username + password wallets, encrypted settings/history vault,
  signed comments and chat, and moderation tools.
- Appearance settings: theme, accent colour, caption styling, page width,
  cards per row, and optional home logo/search.
- Local media cache with per-episode clearing, and an RTX Video diagnostics
  panel with high-performance GPU selection on hybrid laptops.

[Unreleased]: https://github.com/twi-st/twist/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/twi-st/twist/releases/tag/v0.1.0
