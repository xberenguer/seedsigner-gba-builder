# SeedSigner GBA Image Builder v0.2.0

[Open the browser tool](https://xberenguer.github.io/seedsigner-gba-builder/)

Select your own GBA ROM or a ZIP containing one GBA game and download a
personal flashable IMG. ROM processing and image assembly happen in your
browser. The site does not upload, host or distribute commercial game ROMs.

## Use

1. Open the tool in a current desktop browser and choose your hardware profile.
2. Select your `.gba` or single-game `.zip`. V-Rally 3 is detected automatically.
3. Click **Build image**, then **Download IMG**. Keep the SHA-256 file.
4. In Raspberry Pi Imager, choose **Use custom**, select the IMG and your intended
   microSD card. Writing erases that card; let verification finish.
5. Power on the Pi. Hold the outer two of the three action buttons
   (**KEY1 + KEY3**, usually top + bottom) for two seconds, then release all
   buttons to open SeedSigner. Reboot to return
   to the game.

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

V-Rally: D-pad left/right steer; up/down forward/reverse in automatic transmission;
top/middle accelerate/brake; bottom pauses; center changes camera; top+middle
handbrake. Standard GBA exposes D-pad, A, B, Start and Select, without L/R
shoulder buttons. There is no audio or persistent game-save storage.

## Image assembly and validation

The website downloads a checksummed ROM-free template in bounded chunks,
verifies its SHA-256, expands it locally, validates FAT16 and the initramfs,
then inserts the selected game and restricted game/hardware configuration.
The result is a 128 MiB IMG plus its SHA-256. The tool does not flash SD cards.
There are no accounts, analytics, external scripts or ROM-upload endpoints.

The stock kernel, firmware and SeedSigner application come from pinned
SeedSigner 0.8.7 (IMG SHA-256
`67f005c7ace26500a78be3f4d97eaf02d76d018550ec54df011741dde1933ce9`).
The expanded FAT16 partition preserves 334 stock files byte-for-byte; boot
configuration adds the external initramfs directive. The launcher and display
bridge read a restricted hardware profile, and SeedSigner display settings
are set for the chosen screen.

79 Python tests, 11 synthetic browser-engine check groups and nine real
ROM/hardware-profile assembly/readback combinations passed. Checks cover
restricted hardware configuration, display geometry, ROM/ZIP validation,
deterministic reconstruction, corrupt inputs, exact ROM readback and preserved
firmware. A local Brave browser built and downloaded the Celeste Classic 2
regular-display IMG with the same SHA-256 as the Node integration result.
[validation.json](validation.json) and [matrix-validation.json](matrix-validation.json)
record the evidence and its scope. Prior v0.1.0 browser results are recorded
separately from v0.2.0.

Physical cold-boot, display/buttons, gameplay speed, camera and signing checks
remain pending for these exact outputs. This is an experimental community fork
without an independent security audit. Use disposable test seeds for validation.
The game and signer share one OS; the button combination is an interface gate,
not authentication or isolation. Never enter seeds into this website.

## Source, licenses and reproduction

Browser source is directly in this repository. Original code is
GPL-2.0-or-later. A complete IMG and the website's visual assets have separate
third-party licenses; the root license does not cover everything. See
[NOTICE](NOTICE) and [OS/font notices](OS-and-font-notices.txt).

[Runtime corresponding source](source.tar.gz) includes the launcher, display
adapter, native frontend, pinned gpSP/open-BIOS source, template builder and
tests. Its SHA-256 is in template.json. Extract `runtime-source.tar.gz` inside
that bundle for the image-build source tree. Restore the pinned native binaries
and base image as documented in the source manifests; no fresh binary/source
equivalence claim is made by this website. No private game ROM is included.

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
node test-browser-engine.mjs
node test-browser-engine.mjs --manifest template.json --rom /path/to/game.zip --output personal.img
node audit-public.mjs --rom /path/to/game.zip
```

Serve this directory over HTTP locally or HTTPS on GitHub Pages. Opening
index.html through file:// is unsupported. A local copy can operate offline
once all template and site files are available.
