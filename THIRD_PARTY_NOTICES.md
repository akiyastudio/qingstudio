# Third-party dependencies and licenses

English | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

Apache 2.0 covers only original code in this repository and does not replace third-party licenses. This source repository does not include node_modules, Python environments, compiled runtimes, plugin binaries, or models.

The following is the main application dependency index. Actual npm versions are recorded in package-lock.json; direct Python dependencies are in requirements.txt. Check installed packages for transitive dependencies and complete license texts. This source index is not a complete binary-distribution compliance inventory.

| Dependency | Version | License | Upstream |
| --- | --- | --- | --- |
| Electron | 43.4.1 | MIT | [Source](https://github.com/electron/electron) · [License](https://github.com/electron/electron/blob/main/LICENSE) |
| Chromium | Bundled with Electron 43.4.1 | BSD-3-Clause + third-party licenses | [Source](https://chromium.googlesource.com/chromium/src/) · [License](https://chromium.googlesource.com/chromium/src/+/main/LICENSE) |
| Node.js | Bundled with Electron 43.4.1 | MIT + third-party licenses | [Source](https://github.com/nodejs/node) · [License](https://github.com/nodejs/node/blob/main/LICENSE) |
| React / React DOM | 18.3.1 | MIT | [Source](https://github.com/facebook/react) · [License](https://github.com/facebook/react/blob/main/LICENSE) |
| Lucide React | 0.344.0 | ISC | [Source](https://github.com/lucide-icons/lucide) · [License](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |
| noUiSlider | 15.8.1 | MIT | [Source](https://github.com/leongersen/noUiSlider) · [License](https://github.com/leongersen/noUiSlider/blob/master/LICENSE.md) |
| exiftool-vendored | 37.2.0 | MIT | [Source](https://github.com/photostructure/exiftool-vendored.js) · [License](https://github.com/photostructure/exiftool-vendored.js/blob/main/LICENSE) |
| ExifTool | 13.59 | Artistic License 1.0 or GPL | [Source](https://exiftool.org/) · [License](https://dev.perl.org/licenses/) |
| Python | 3.12.10 | PSF License | [Source](https://github.com/python/cpython) · [License](https://docs.python.org/3/license.html) |
| PyInstaller | 6.17.0 | GPL-2.0-or-later (bootloader exception) | [Source](https://github.com/pyinstaller/pyinstaller) · [License](https://pyinstaller.org/en/stable/license.html) |
| NumPy | 2.2.6 | BSD-3-Clause | [Source](https://github.com/numpy/numpy) · [License](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| Pillow | 12.0.0 | HPND | [Source](https://github.com/python-pillow/Pillow) · [License](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| rawpy | 0.27.0 | MIT | [Source](https://github.com/letmaik/rawpy) · [License](https://github.com/letmaik/rawpy/blob/main/LICENSE) |
| LibRaw | Bundled with stable rawpy 0.27.0 binaries | LGPL-2.1-or-later OR CDDL-1.0 | [Source](https://www.libraw.org/) · [License](https://www.libraw.org/about) |
| pi-heif | 1.4.0 | BSD-3-Clause | [Source](https://github.com/bigcat88/pillow_heif) · [License](https://github.com/bigcat88/pillow_heif/blob/master/LICENSE.txt) |
| libheif / libde265 | 1.23.0 / 1.1.1 | LGPL-3.0 | [Source](https://github.com/strukturag/libheif) · [License](https://github.com/strukturag/libheif/blob/master/COPYING) |
| OpenCV / opencv-python-headless | 4.12.0.88 | Apache-2.0 | [Source](https://github.com/opencv/opencv) · [License](https://github.com/opencv/opencv/blob/4.x/LICENSE) |
| Send2Trash | 1.8.3 | BSD-3-Clause | [Source](https://github.com/arsenetar/send2trash) · [License](https://github.com/arsenetar/send2trash/blob/main/LICENSE) |

When building or distributing installers, retain the licenses and notices shipped with Electron/Chromium and other dependencies. For dependencies such as LGPL libraries, meet the corresponding-source, replacement, or relinking obligations applicable to the actual packaging. This index does not replace those materials. Build tools and other npm dependencies have licenses in their respective packages.
