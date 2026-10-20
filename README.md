# Twist

A desktop app for watching anime. Ad-free, no accounts required to watch, and it
keeps your library, history and settings on your own machine.

**[Download for Windows, macOS or Linux →](../../releases/latest)**

---

## What you get

**A player that behaves like one.**
Quality selection, subtitles with adjustable styling, skip intro and outro,
auto-play, auto-next, keyboard shortcuts, and fullscreen that survives switching
episodes. If your connection drops a gear, it picks a rendition you can actually
sustain instead of buffering.

**More than one source.**
Several mirrors are supported and tried automatically. If one is down or slow,
the app moves on instead of leaving you staring at a spinner. You can also pick a
specific source yourself when you want to.

**Your own subtitles.**
Subtitles shipped with the stream always come first, and you can pull additional
languages from OpenSubtitles from inside the player.

**Watch offline.**
Download episodes at the quality you want, pause and resume, and play them back
with no connection at all.

**Torrent streaming, if you want it.**
An optional mode streams episodes directly from torrents and treats them like a
normal episode — you can seek, and it knows how long the episode is. It is off by
default and asks before it does anything, because it has real trade-offs (see
below).

**It remembers where you were.**
Continue watching picks up mid-episode, the library keeps things for later, and
history is per-episode — including the ability to delete a single episode without
wiping everything.

**A community layer that lives on your device.**
Comments, chat and a profile, with an account derived from a username and
password. Your keys never leave your machine and nothing is uploaded in plain
text.

## Requirements

- **Windows 10/11** — uses the WebView2 runtime, which is already installed on
  Windows 11 and current Windows 10.
- **macOS 12+** — Apple Silicon and Intel.
- **Linux** — GTK 3 or GTK 4 with WebKitGTK.
- **ffmpeg** — only needed for torrent streaming. The app can download a build
  for you, or you can point it at an existing install.

## Install

Download the build for your platform from the
[latest release](../../releases/latest):

| Platform | File |
| --- | --- |
| Windows | `.exe` installer, or the portable `.exe` |
| macOS | `.dmg` (Apple Silicon or Intel) |
| Linux | `.AppImage`, `.deb`, or `.rpm` |

The builds are unsigned. On Windows, SmartScreen may warn you about an unknown
publisher; on macOS you may need to right-click → Open the first time. Verify the
download against the checksums published with each release.

## Disclaimers

**Twist is a player, not a source.** It ships with no content, no catalogue and
no credentials for any service. It does not host, index, mirror or distribute
anything. It resolves streams from third-party providers the same way a browser
does, and plays them on your machine.

**You are responsible for how you use it.** What you watch, and whether you have
the right to watch it, is on you. Comply with the laws where you live and with
the terms of any service you use. The authors do not endorse or encourage
copyright infringement and cannot take responsibility for what you point the app
at.

**No warranty.** The software is provided as-is, without warranty of any kind. It
talks to third-party services that are not affiliated with this project and that
can change or disappear at any time. Nothing here is guaranteed to work, and
mirrors breaking is a normal thing that happens.

**Torrent streaming is opt-in for a reason.** When you enable it, your IP address
is visible to other peers in the swarm — that is how BitTorrent works, and no
client can hide it. Only turn it on if you understand that, and only in a
jurisdiction where you are allowed to.

**Accounts are local-first.** Your password derives your keys on your device and
is never sent anywhere. That also means nobody can recover your account for you
if you forget it.

**No telemetry.** The app does not phone home, and there is no analytics.

## Contributing

Issues and pull requests are welcome. If you are reporting a broken source,
please include the episode and what you saw — "it doesn't work" is hard to act
on.

## License

[MIT](LICENSE)
