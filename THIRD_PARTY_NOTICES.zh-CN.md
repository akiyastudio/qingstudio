[English](THIRD_PARTY_NOTICES.md) | 简体中文

# 第三方依赖与许可

Apache 2.0 仅适用于本仓库原创代码，不替代第三方许可。本仓库不提交 node_modules、Python 环境、编译后运行库、插件二进制或模型。

以下是主程序依赖索引；实际 npm 版本以 package-lock.json 为准，Python 直接依赖以 requirements.txt 为准。传递依赖及其完整许可应从实际安装的软件包中核对。源码依赖索引不是完整的二进制发行合规清单。

| 依赖 | 版本 | 许可证 | 上游 |
| --- | --- | --- | --- |
| Electron | 43.4.1 | MIT | [源码](https://github.com/electron/electron) · [许可](https://github.com/electron/electron/blob/main/LICENSE) |
| Chromium | 随 Electron 43.4.1 | BSD-3-Clause + 第三方许可 | [源码](https://chromium.googlesource.com/chromium/src/) · [许可](https://chromium.googlesource.com/chromium/src/+/main/LICENSE) |
| Node.js | 随 Electron 43.4.1 | MIT + 第三方许可 | [源码](https://github.com/nodejs/node) · [许可](https://github.com/nodejs/node/blob/main/LICENSE) |
| React / React DOM | 18.3.1 | MIT | [源码](https://github.com/facebook/react) · [许可](https://github.com/facebook/react/blob/main/LICENSE) |
| Lucide React | 0.344.0 | ISC | [源码](https://github.com/lucide-icons/lucide) · [许可](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |
| noUiSlider | 15.8.1 | MIT | [Source](https://github.com/leongersen/noUiSlider) · [License](https://github.com/leongersen/noUiSlider/blob/master/LICENSE.md) |
| exiftool-vendored | 37.2.0 | MIT | [源码](https://github.com/photostructure/exiftool-vendored.js) · [许可](https://github.com/photostructure/exiftool-vendored.js/blob/main/LICENSE) |
| ExifTool | 13.59 | Artistic License 1.0 或 GPL | [源码](https://exiftool.org/) · [许可](https://dev.perl.org/licenses/) |
| Python | 3.12.10 | PSF License | [源码](https://github.com/python/cpython) · [许可](https://docs.python.org/3/license.html) |
| PyInstaller | 6.17.0 | GPL-2.0-or-later（Bootloader 例外） | [源码](https://github.com/pyinstaller/pyinstaller) · [许可](https://pyinstaller.org/en/stable/license.html) |
| NumPy | 2.2.6 | BSD-3-Clause | [源码](https://github.com/numpy/numpy) · [许可](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| Pillow | 12.0.0 | HPND | [源码](https://github.com/python-pillow/Pillow) · [许可](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| rawpy | 0.27.0 | MIT | [源码](https://github.com/letmaik/rawpy) · [许可](https://github.com/letmaik/rawpy/blob/main/LICENSE) |
| LibRaw | 随 rawpy 0.27.0 稳定版二进制包 | LGPL-2.1-or-later OR CDDL-1.0 | [源码](https://www.libraw.org/) · [许可](https://www.libraw.org/about) |
| pi-heif | 1.4.0 | BSD-3-Clause | [源码](https://github.com/bigcat88/pillow_heif) · [许可](https://github.com/bigcat88/pillow_heif/blob/master/LICENSE.txt) |
| libheif / libde265 | 1.23.0 / 1.1.1 | LGPL-3.0 | [源码](https://github.com/strukturag/libheif) · [许可](https://github.com/strukturag/libheif/blob/master/COPYING) |
| OpenCV / opencv-python-headless | 4.12.0.88 | Apache-2.0 | [源码](https://github.com/opencv/opencv) · [许可](https://github.com/opencv/opencv/blob/4.x/LICENSE) |
| Send2Trash | 1.8.3 | BSD-3-Clause | [源码](https://github.com/arsenetar/send2trash) · [许可](https://github.com/arsenetar/send2trash/blob/main/LICENSE) |

构建或分发安装包时，应保留 Electron/Chromium 及其他依赖随附的许可证和声明。对 LGPL 等依赖，还需依据实际打包方式满足对应源码、替换或重新链接等要求；不能仅凭此索引代替这些材料。构建工具及其他 npm 依赖的许可见各自软件包。
