# Hardware evidence — 2026-10-11

The research references are actual product photographs; original downloads were unmodified and WebP versions use lossless encoding. The site now displays original SVG illustrations, with the photographs retained as provenance references in `sources.json`. That record includes illustration hashes, source URLs, credits and rights status. Neither a photograph nor an illustration establishes runtime compatibility.

| Hardware | Board and display | Controls and physical differences | Confidence and builder implications |
|---|---|---|---|
| BitKit SeedSigner Play | Maker lists 2.8-inch display and no wireless functionality. Product page does not name the SBC revision, display controller, pixel resolution or GPIO wiring. | Black portrait case; screen above five separate direction/select buttons and three vertically arranged action buttons (eight total). Two SD slots: maker explicitly says top for operation, bottom for storage. Maker lists 99 × 76 × 16 mm. USB-C cable included. | Photos and external shape verified. Do not mark this image compatible until actual panel/controller, button wiring and orientation are confirmed. The maker's listing does not establish the panel's native or configured orientation; the angled photograph alone cannot confirm it. Do not conflate dual SD slots with this project's single-card image design. |
| SeedSigner Plus / BitKit Plus photo | Standard Plus HAT reference uses Raspberry Pi Zero family and 2.8-inch IPS 240 × 320 panel, ST7789, 40-pin LCD connector. Software uses landscape 320 × 240. LCD outline 47.8 × 66.95 × 2.13 mm. BitKit's listing confirms 2.8 inches and no wireless, but does not disclose exact SBC revision. | Photo: orange rounded capsule, screen between five direction/select buttons and three action buttons (eight total). Plus standard design offers USB-C power-only and spring-loaded SD extension. | The Plus project profile is specifically Pi Zero v1.3 + Plus ST7789 landscape 320 × 240. Reference-design facts should be labelled as standard Plus, not treated as manufacturer confirmation of every BitKit internal part. |
| Regular SeedSigner (Waveshare 1.3-inch HAT) | Official SeedSigner guide specifies Raspberry Pi Zero v1.3 + Waveshare 1.3-inch 240 × 240 HAT + Pi camera. Waveshare SKU 14972 uses ST7789 over SPI, 3.3 V, 65K color. | Five-way joystick (up/down/left/right/press) plus three pushbuttons; compact landscape enclosure around square screen. Pi Zero board has two micro-USB ports and mini-HDMI; enclosure access varies. | Established reference hardware, but v0.2.0 provides an experimental display adapter and matching SeedSigner settings; physical validation remains pending. Same ST7789 name does not mean same geometry. |

## Primary sources

- BitKit Play: https://bitkitbtc.com/product/seedsigner-play/
- BitKit Plus: https://bitkitbtc.com/product/seedsigner-plus/
- Plus HAT design repository: https://github.com/3rdIteration/seedsigner-hardware/tree/main/display_hats/plus_hat
- Plus HAT exact LCD specifications: https://raw.githubusercontent.com/3rdIteration/seedsigner-hardware/main/display_hats/plus_hat/README.md
- SeedSigner official component guide: https://seedsigner.com/seedsigner-independent-custody-guide/
- Waveshare product specifications and GPIO mapping: https://www.waveshare.com/1.3inch-LCD-HAT.htm
- Bitcoin Design SeedSigner case study and photos: https://bitcoin.design/guide/case-studies/seedsigner/
- Photo license: https://github.com/BitcoinDesign/Guide/blob/master/LICENSE

## Photograph reference attribution

The regular-device research reference is `seedsigner-regular-enclosed.webp` (961 × 451). Its credit is “Photo: Bitcoin Design Guide contributors · CC BY 4.0,” with the case study and https://creativecommons.org/licenses/by/4.0/. Original downloads are unmodified; WebP derivatives use lossless encoding and were pixel-compared to originals. It informs the illustrated enclosure and is not displayed on the site.

BitKit photos are manufacturer-origin references, but the product pages do not state an open reuse license. Keep a BitKit photo/source link and exclude these assets from the root GPL coverage. Rights status is unknown, not confirmed public-domain. The unlit Play photograph avoids implying any commercial game is bundled.

The original photograph research did not modify hardware or runtime behavior. The later vector illustration pass is documented below; its geometry is inspectable SVG, with no AI-generated bitmap device image.

## Published vector illustration scope — 2026-10-11

The site uses original, self-contained SVG hardware illustrations. Product photographs remain research references; they are not embedded in the renders. Each screen is a composite of a credited game-frame capture, not a device photograph or hardware-test result. Perspective and materials are illustrative. Comparative size is approximate and must not be labelled exact scale.

- Play: the maker-listed 99 × 76 × 16 mm enclosure supports a 76:99 front ratio; the photo supplies eight separate tactile switches, four front screws and two left-side SD slots. The landscape screen opening is visually referenced, not proof of panel orientation or controller compatibility.
- Plus: reference CAD `Plus_Reference_Main.3mf` bounds are 144.4 × 58.5 × 22.25 mm. Its front ratio and button/screen positions inform the illustration. The top display bevel is 61.8005 × 47.4052 mm, centered at (7.04285, −0.1286) mm in case-centered coordinates. Five 8 × 8 mm button holes form the left cross, with center (−44.1416, 0.1792) mm and approximately 10.6 mm spacing. Three action holes share x=49.6422 mm with y=−9.4199, 1.0801 and 11.5801 mm. These are reference-design measurements, not confirmation of the pictured BitKit device's manufacture.
- Regular: the Bitcoin Design reference photograph supplies the roughly 2.13:1 front silhouette, one circular joystick, square panel and three right action caps. Exact case identity and dimensions are unconfirmed. Official Orange Pill CAD has a different 100 × 34.5 mm footprint and is not silently substituted for the pictured case.

Plus CAD source: https://github.com/3rdIteration/seedsigner-hardware/tree/main/signer_enclosures/seedsigner_plus/reference_design

Illustration asset hashes, model references and embedded frame provenance are in `sources.json`. The hero uses V-Rally 3; device cards use Pokémon (Play), Doom (Plus) and Celeste Classic 2 (regular). Source frame aspect ratios are retained with letterboxing. Original vector artwork is GPL-2.0-or-later; embedded game artwork retains its original rights. Credit Bitcoin Design Guide contributors for the regular-device reference under CC BY 4.0.
