# SeedSigner GBA Image Builder

[Open the browser tool](https://xberenguer.github.io/seedsigner-gba-builder/)

Select your own GBA ROM or a ZIP containing one GBA game and download a
flashable personal IMG. All ROM processing and image assembly happen in your
browser. The site does not upload, host or distribute commercial game ROMs.

## Use

1. Open the tool in a current desktop browser.
2. Choose your `.gba` or single-game `.zip`. V-Rally 3 is detected automatically.
3. Click **Build image**, then **Download IMG**. Keep the SHA-256 file.
4. In Raspberry Pi Imager, use **Use custom**, choose the IMG and your intended
   microSD card. Writing erases that card; let verification finish.
5. Power on the Pi. Hold **top + bottom side buttons for two seconds**, then
   release all buttons to open SeedSigner through its original splash.

Supported target: **Raspberry Pi Zero v1.3, SeedSigner Plus ST7789 320×240 HAT**.
Regular 240×240 screens and other boards are not supported by this template.

The tool accepts valid GBA headers up to 32 MiB, or ZIP32 archives up to 40 MiB
containing one GBA file. Packaging success does not prove game compatibility
or full speed. Other console ROMs require different emulator integrations.

V-Rally: D-pad left/right steer; up/down forward/reverse in automatic transmission;
top/middle accelerate/brake; bottom pauses; center changes camera; top+middle
handbrake. Standard GBA exposes D-pad, A, B, Start and Select; no L/R shoulders.
There is no audio or persistent game save storage. Reboot returns to the game.

## What the tool does

The website downloads a checksummed ROM-free template in two bounded chunks,
verifies its SHA-256, expands it locally, validates the FAT16 filesystem and
initramfs, inserts the selected ROM and restricted game configuration, and
downloads a 128 MiB IMG plus SHA-256. It does not flash SD cards. No backend,
accounts, analytics, external scripts or ROM upload endpoint are used.

The kernel, firmware and SeedSigner application come from pinned stock
SeedSigner 0.8.7 (IMG SHA-256
`67f005c7ace26500a78be3f4d97eaf02d76d018550ec54df011741dde1933ce9`).
The expanded FAT16 partition preserves 334 stock files byte-for-byte; only
boot config adds the external initramfs directive. The original working
V-Rally emulator/frontend/display bridge bytes are preserved.

## Validation and limits

61 Python tests and 11 browser-engine checks passed, including the supplied
V-Rally ZIP, deterministic template reconstruction, corrupted inputs, exact
ROM readback and unchanged firmware. A real desktop browser assembled and
downloaded the same personal image as the command-line integration check.
`validation.json` records validation scope. The exact generated image still
requires physical cold-boot, buttons/display, gameplay, camera and signing
checks on the Pi. This is experimental, not an independently audited wallet.
Use disposable test seeds for validation. The game and signer share one OS;
the button combination is an interface gate, not authentication or isolation.
Never enter seeds into this website.

## Source, licenses and reproduction

Browser source is directly in this repository. Original code is GPL-2.0-or-later;
third-party licenses remain separate. See LICENSE, NOTICE and
[OS/font notices](OS-and-font-notices.txt).

[Runtime corresponding source](source.tar.gz) includes the launcher, native
frontend, pinned gpSP/open-BIOS source, template builder and tests. Its SHA-256
is in template.json. Extract `runtime-source.tar.gz` inside that bundle for
the image build source tree. Restore the pinned native binaries and base image
as documented in the source manifests; no fresh binary/source equivalence
claim is made by this website. The private V-Rally ROM is never included.

[Stock OS corresponding source](https://github.com/xberenguer/seedsigner-dino/releases/download/v0.1.1-beta/seedsigner-v0.8.7-os-corresponding-source.tar.gz)
SHA-256: `20751b5076b6b309928bd650f9846d2481f16a5f5d85943071b285abc246f6c6`.

Run browser-engine tests with Node 22 or newer:

```sh
node test-browser-engine.mjs
node test-browser-engine.mjs --manifest template.json --rom /path/to/game.zip --output personal.img
```

Serve this directory over HTTP locally or HTTPS on GitHub Pages; opening index.html
through file:// is not supported. Downloading the repository and serving it
locally also allows offline use after the template files are available.
