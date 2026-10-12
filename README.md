# SeedSigner GBA Image Builder v0.2.4

[Open the browser tool](https://xberenguer.github.io/seedsigner-gba-builder/)

Select your own GBA ROM or a ZIP containing one GBA game and download a
personal flashable IMG. ROM processing and image assembly happen in your
browser. The site does not upload, host or distribute commercial game ROMs.

## Use

1. Open the tool in a current desktop browser and choose **Regular** or
   **Larger (Plus / Play)** to match your display.
2. Select your `.gba` or single-game `.zip`. V-Rally 3 is detected automatically.
   Optionally open **Advanced** to change controls or the SeedSigner shortcut.
3. Click **Build image**, then **Download IMG**. Keep the SHA-256 file.
4. In Raspberry Pi Imager, choose **Use custom**, select the IMG and your intended
   microSD card. Writing erases that card; let verification finish.
5. Power on the Pi. By default, hold the outer two of the three action buttons
   (**KEY1 + KEY3**, usually top + bottom) for two seconds, then release all
   buttons for 80 ms to open SeedSigner. If you customized the shortcut in
   Advanced, use the buttons and timing shown with your download. Reboot to
   return to the game.

## Hardware scope

The template uses the Raspberry Pi Zero ARMv6 image of SeedSigner 0.8.7. The
reference board is the non-wireless **Pi Zero v1.3**. Select the display that
actually matches your hardware; a photograph or product name cannot establish
controller, wiring or board compatibility.

| Profile | Required display and controls | Validation status |
|---|---|---|
| **Plus** | Plus-type ST7789 HAT, landscape 320 × 240, standard SeedSigner GPIO wiring | Software tested; physical qualification of this exact image remains pending |
| **Play** | Pi Zero ARMv6, Plus-compatible ST7789 landscape 320 × 240 and standard SeedSigner GPIO wiring | Conditional profile; BitKit's product page does not disclose enough internal hardware detail to confirm a match |
| **Regular** | Waveshare 1.3-inch ST7789 240 × 240 HAT, five-way joystick and three action buttons | Experimental display adapter; software tested, physical boot/display/controls/signing validation pending |

BitKit Play is a distinct portrait enclosure with a 2.8-inch screen and two
microSD slots; the maker describes the top slot as operational and the bottom
as storage. This builder inserts the game into **one boot image** and does not
configure a second storage card. See [hardware evidence and sources](HARDWARE-RESEARCH.md).

## Games and controls

The tool accepts GBA headers up to 32 MiB, or ZIP32 archives up to 40 MiB
containing one GBA file. Header validation and successful packaging do not
prove a game will run correctly or at full speed. Other console ROMs need
different emulator integrations.

**Classic NES Series: Super Mario Bros. (FSME)** automatically uses a separate
compatibility core. Its ARM7 instruction-prefetch and EEPROM handling fixes
the original startup failure. The compatibility core now dynamically recompiles
ordinary RAM/ROM code and interprets only the mutable VRAM instructions that
need the prefetch fix. The unmodified game file reaches the title and World 1-1
with movement, jumps and coin pickup in ARMv6 software tests. The frontend also
keeps fresh screen updates when a core cannot maintain the game clock. Other
games retain the original gpSP core. Physical Pi Zero speed remains to be verified.

V-Rally: D-pad left/right steer; up/down forward/reverse in automatic transmission;
top/middle accelerate/brake; bottom pauses; center changes camera; top+middle
handbrake. Standard GBA exposes D-pad, A, B, Start and Select. Its default map
does not assign L/R; **Advanced** can map those GBA inputs to existing HAT
buttons. There is no audio or persistent game-save storage.

### Examples and testing status

| Game | Evidence and limits |
|---|---|
| **Crash Bandicoot: The Huge Adventure** | Creator tested: the creator personally reported it working well on 2026-10-12. Hardware, display profile and build version were not specified. |
| **Pokémon Ruby / Sapphire** | Not yet tested on this fork. The screenshot is an official Nintendo example, not a compatibility result. Persistent saves are not available, so progress is lost when the session ends. |
| **Classic NES Series: Super Mario Bros.** | Software checked: World 1-1 gameplay, movement, jumps, question blocks and a Goomba stomp were captured with the ARMv6 runtime under software emulation. Physical gameplay and speed remain unverified. |

These game-specific results do not establish full hardware qualification.
Cold-boot, display/buttons, camera and signing checks remain pending for
the exact generated images. Other examples retain their individual evidence
limits; compatibility and speed vary. Use your own game files; no game ROMs
are bundled or distributed. See [game-frame sources](game-sources.json) and
[Mario capture evidence](scroll-sources-v2.json).

Basic use needs only a display and game. Advanced provides automatic, standard,
V-Rally 3 and custom control choices, with a separate mapping for each of the
eight physical HAT buttons. Select a GBA action, **None**, or the combined
Up + R / Down + L actions used by the racing preset. Assigning an input does
not add a physical button; eight HAT buttons cannot provide ten distinct GBA
buttons at once.

The SeedSigner shortcut uses two or three selected **physical** HAT buttons,
independently of their game mappings. The hold time is configurable from
0.5 to 10 seconds, and every button must remain released for 50–1,000 ms.
The defaults are KEY1 + KEY3, 2 seconds, then 80 ms released. Once the complete
shortcut is held or latched, its buttons' game actions are suppressed. A short
or interrupted hold does not open SeedSigner. Reset restores the automatic
preset and default shortcut. Advanced does not expose audio, saves, BIOS,
frameskip or other emulator options that this runtime does not implement.

## Image assembly and validation

The website downloads a checksummed ROM-free template in bounded chunks,
verifies its SHA-256, expands it locally, validates FAT16 and the initramfs,
then inserts the selected game and restricted game/hardware configuration.
The result is a 128 MiB IMG plus its SHA-256. The tool does not flash SD cards.
There are no accounts, analytics, external scripts or ROM-upload endpoints.

Custom mappings or shortcut settings also download a checksummed, ROM-free
[Advanced runtime payload](advanced-runtime.json). It replaces five existing
initramfs files: the launcher, ARMv6 frontend, matching frontend/launcher source
archive, and their two source manifests. The base template and its published
checksums remain unchanged. Basic builds retain the existing runtime.

The stock kernel, firmware and SeedSigner application come from pinned
SeedSigner 0.8.7 (IMG SHA-256
`67f005c7ace26500a78be3f4d97eaf02d76d018550ec54df011741dde1933ce9`).
The expanded FAT16 partition preserves 334 stock files byte-for-byte; boot
configuration adds the external initramfs directive. The launcher and display
bridge read a restricted hardware profile, and SeedSigner display settings
are set for the chosen screen.

The v0.2.3 baseline recorded passing results for 33 launcher/display/bridge/template
tests, 13 native frontend tests, 12 browser-engine groups and twelve real
ROM/display-profile assembly/readback combinations. Template assembly repeated
with an identical SHA-256. See [validation.json](validation.json) and
[matrix-validation.json](matrix-validation.json); prior results are kept
as historical evidence.
The compatibility core and frontend rebuilt byte-identically from their
corresponding sources. Sustained 20/30/40 ms mock-core delays keep changing
display frames and responsive input, including deliberate signer entry; these
are software regression tests, not physical Pi frame-rate measurements.

The v0.2.4 Advanced update passed 33 launcher compatibility tests, 6 new
configuration/recovery tests, the native self-test and 17 native frontend
tests. The ARMv6 frontend rebuilt byte-identically and passed self-test and a
custom hold/release check under QEMU ARM1176 with the stock SeedSigner libc.
The browser engine and worker passed 18 test groups, plus an actual-template
integration group with synthetic-ROM assembly/readback for all six display/preset
combinations and the FSME core selection. All 34 files in the new corresponding-source
archive matched its manifest. These checks use host tests and software emulation, not a physical
device or new game-playability test. See [advanced-validation.json](advanced-validation.json).

The failure screen shows game availability and retry instructions. Its retry
button is chosen outside a customized signer shortcut, so a partial shortcut
cannot trigger a retry. Game or GPIO failures do not implicitly enter SeedSigner.

Full physical qualification, including cold-boot, display/buttons, sustained
gameplay speed, camera and signing, remains pending for these exact outputs.
The creator-reported Crash gameplay result above is a narrower check.
This is an experimental community fork
without an independent security audit. Use disposable test seeds for validation.
The game and signer share one OS; the button combination is an interface gate,
not authentication or isolation. Never enter seeds into this website.

## Source, licenses and reproduction

Browser source is directly in this repository. Original code is
GPL-2.0-or-later. A complete IMG and the website's visual assets have separate
third-party licenses; the root license does not cover everything. See
[NOTICE](NOTICE) and [OS/font notices](OS-and-font-notices.txt).

[Baseline runtime corresponding source](source.tar.gz) includes the launcher, display
adapter, native frontend, pinned gpSP/open-BIOS source, template builder and
tests. Its SHA-256 is in template.json. Extract `runtime-source.tar.gz` inside
that bundle for the baseline image-build source tree. It remains the source
for the unchanged base template, not the updated Advanced frontend.

The [Advanced runtime JSON](advanced-runtime.json) includes the complete updated
launcher/frontend sources, tests and build recipes as the base64 file entry
`opt/dino/native/source/gba-web-native-source.tar.gz`. The same archive is
embedded at that path in a customized IMG. Its source manifests record the
new binary and source hashes; the gpSP cores, embedded open BIOS and their
baseline corresponding sources are unchanged. No private game ROM is included.

For v0.2.4 the Advanced payload SHA-256 is
`3ef6847b9d38d31bcfaae96ce238e58ea57acf11aaf7e3c29ebfbc3319a50add`.
Download `advanced-runtime.json` and verify/extract the source archive without
executing its contents:

```sh
python3 - <<'PY'
import base64, hashlib, json
from pathlib import Path

data = Path("advanced-runtime.json").read_bytes()
assert hashlib.sha256(data).hexdigest() == "3ef6847b9d38d31bcfaae96ce238e58ea57acf11aaf7e3c29ebfbc3319a50add"
payload = json.loads(data)
entry = next(item for item in payload["files"]
             if item["path"] == "opt/dino/native/source/gba-web-native-source.tar.gz")
source = base64.b64decode(entry["base64"], validate=True)
assert len(source) == entry["bytes"]
assert hashlib.sha256(source).hexdigest() == entry["sha256"] == "c18e1ef6b77e8547b4d39c75f8abb3a0b4e707738dc8048277775460572ac639"
Path("advanced-controls-source.tar.gz").write_bytes(source)
print("Verified Advanced corresponding source")
PY
mkdir advanced-controls-source
tar -xzf advanced-controls-source.tar.gz -C advanced-controls-source
```

Inside that source tree, `ADVANCED-CONTROLS.txt` documents the strict optional
`advanced` configuration and native arguments. Build on Linux with Debian
GCC 12.2 ARM cross-tools and the original Raspbian GCC 8 ARMv6 sysroot:

```sh
cd advanced-controls-source
sh scripts/build_native_armv6_cross.sh "$PWD" /path/to/original-armv6-sysroot ./rebuilt
sha256sum rebuilt/dino-native
```

The expected frontend SHA-256 is
`7444a3f1313915fd0288b4f843ea05a0e62b53e1252e4f5263ef9acd49bc8061`.
The original toolchain filesystem image used for these checks has SHA-256
`dab23d6040bad1d421368fc6dafd914888e42111e0997e750f96d6e8ea6fa353`;
it was mounted read-only. The script uses its headers, startup objects and
libraries rather than ARMv7 defaults, and records ELF architecture and GLIBC
requirements. `scripts/build_advanced_runtime_payload.py` reproduces the JSON
payload from the pinned base template and rebuilt frontend. Build and source
equivalence are software results; physical validation is separate.

[Stock OS corresponding source](https://github.com/xberenguer/seedsigner-dino/releases/download/v0.1.1-beta/seedsigner-v0.8.7-os-corresponding-source.tar.gz)
SHA-256: `20751b5076b6b309928bd650f9846d2481f16a5f5d85943071b285abc246f6c6`.

The gpSP core is GPL-2.0-or-later. Its open GBA BIOS retains its upstream
GPL-2.0 notice; no Nintendo BIOS is distributed. Original monochrome hardware
renders show the distinct Play, Plus and regular enclosure/control layouts.
[Render sources and geometry references](hardware-sources.json) record
the maker photographs and reference CAD used. Illustrations and example-screen
composites are approximate in perspective and scale, and are not hardware-test
evidence. Original SVG artwork is GPL-2.0-or-later; embedded game frames retain
their own rights. The regular-device reference is credited under **CC BY 4.0**.
Manufacturer photographs are references and are not embedded. Inter is self-hosted under
**SIL OFL 1.1**, with its [copyright and license](Inter-LICENSE.txt).

Run browser-engine tests and the read-only public-payload audit with Node 22+:

```sh
node test-browser-engine-v0.2.4.mjs
node test-browser-engine-v0.2.4.mjs --advanced-template /path/to/template.img --advanced-report advanced-validation-local.json
node test-browser-engine-v0.2.4.mjs --manifest template.json --rom /path/to/game.zip --output personal.img
node audit-public-v0.2.4.mjs --rom /path/to/game.zip
```

Serve this directory over HTTP locally or HTTPS on GitHub Pages. Opening
index.html through file:// is unsupported. A local copy can operate offline
once all template and site files are available.
