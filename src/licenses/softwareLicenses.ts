export interface ThirdPartySoftwareLicense {
  group: '主程序' | '本地组件';
  name: string;
  version: string;
  purpose: string;
  license: string;
  sourceUrl: string;
  licenseUrl: string;
  note?: string;
  attention?: boolean;
}

export const THIRD_PARTY_SOFTWARE_LICENSES: ThirdPartySoftwareLicense[] = [
  { group: '主程序', name: 'Electron', version: '43.4.1', purpose: '桌面应用运行框架', license: 'MIT', sourceUrl: 'https://github.com/electron/electron', licenseUrl: 'https://github.com/electron/electron/blob/main/LICENSE' },
  { group: '主程序', name: 'Chromium', version: '随 Electron 43.4.1', purpose: '网页渲染与多媒体运行环境', license: 'BSD-3-Clause + 第三方许可', sourceUrl: 'https://chromium.googlesource.com/chromium/src/', licenseUrl: 'https://chromium.googlesource.com/chromium/src/+/main/LICENSE', note: '发布包还必须保留 Electron 随附的 LICENSES.chromium.html。' },
  { group: '主程序', name: 'Node.js', version: '随 Electron 43.4.1', purpose: '主进程与本地文件功能', license: 'MIT + 第三方许可', sourceUrl: 'https://github.com/nodejs/node', licenseUrl: 'https://github.com/nodejs/node/blob/main/LICENSE' },
  { group: '主程序', name: 'React / React DOM', version: '18.3.1', purpose: '界面渲染', license: 'MIT', sourceUrl: 'https://github.com/facebook/react', licenseUrl: 'https://github.com/facebook/react/blob/main/LICENSE' },
  { group: '主程序', name: 'Lucide React', version: '0.344.0', purpose: '界面图标', license: 'ISC', sourceUrl: 'https://github.com/lucide-icons/lucide', licenseUrl: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE' },
  { group: '主程序', name: 'exiftool-vendored', version: '37.2.0', purpose: 'ExifTool 进程管理与元数据读取', license: 'MIT', sourceUrl: 'https://github.com/photostructure/exiftool-vendored.js', licenseUrl: 'https://github.com/photostructure/exiftool-vendored.js/blob/main/LICENSE' },
  { group: '主程序', name: 'ExifTool', version: '13.59', purpose: '照片和视频元数据读取', license: 'Artistic License 1.0 或 GPL', sourceUrl: 'https://exiftool.org/', licenseUrl: 'https://dev.perl.org/licenses/' },

  { group: '本地组件', name: 'Python', version: '3.12.10', purpose: '文件工具与可选组件运行时', license: 'PSF License', sourceUrl: 'https://github.com/python/cpython', licenseUrl: 'https://docs.python.org/3/license.html' },
  { group: '本地组件', name: 'PyInstaller', version: '6.17.0', purpose: '生成自包含组件可执行文件', license: 'GPL-2.0-or-later（Bootloader 例外）', sourceUrl: 'https://github.com/pyinstaller/pyinstaller', licenseUrl: 'https://pyinstaller.org/en/stable/license.html', note: '例外允许分发由 PyInstaller 生成的应用；修改 PyInstaller 本身时仍需遵守 GPL。' },
  { group: '本地组件', name: 'NumPy', version: '2.2.6', purpose: '图像和向量计算', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/numpy/numpy', licenseUrl: 'https://github.com/numpy/numpy/blob/main/LICENSE.txt' },
  { group: '本地组件', name: 'Pillow', version: '12.0.0', purpose: '图片读取、缩略图和颜色处理', license: 'HPND', sourceUrl: 'https://github.com/python-pillow/Pillow', licenseUrl: 'https://github.com/python-pillow/Pillow/blob/main/LICENSE' },
  { group: '主程序', name: 'rawpy', version: '0.27.0', purpose: '内置 RAW 解码器的 LibRaw Python 封装', license: 'MIT', sourceUrl: 'https://github.com/letmaik/rawpy', licenseUrl: 'https://github.com/letmaik/rawpy/blob/main/LICENSE' },
  { group: '主程序', name: 'LibRaw', version: '随 rawpy 0.27.0 稳定版二进制包', purpose: '内置相机 RAW 传感器数据解析、去马赛克和色彩转换', license: 'LGPL-2.1-or-later OR CDDL-1.0', sourceUrl: 'https://www.libraw.org/', licenseUrl: 'https://www.libraw.org/about' },
  { group: '本地组件', name: 'pi-heif', version: '1.4.0', purpose: 'HEIC、HEIF 与 HIF 图片解码及 Pillow 集成', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/bigcat88/pillow_heif', licenseUrl: 'https://github.com/bigcat88/pillow_heif/blob/master/LICENSE.txt', note: 'pi-heif 组件使用仅解码版本，不包含 HEIF 编码功能。Windows 二进制包同时包含 LGPL-3.0 的 libheif 与 libde265；FFmpeg 的 x265 转码组件单独列示。' },
  { group: '本地组件', name: 'libheif / libde265', version: '1.23.0 / 1.1.1', purpose: 'HEIF 容器解析与 HEVC 图片解码', license: 'LGPL-3.0', sourceUrl: 'https://github.com/strukturag/libheif', licenseUrl: 'https://github.com/strukturag/libheif/blob/master/COPYING', note: '由 pi-heif 的 Windows 二进制包携带，仅启用解码能力。' },
  { group: '本地组件', name: 'OpenCV / opencv-python-headless', version: '4.12.0.88', purpose: '视频、人物检测前后处理与图像合成', license: 'Apache-2.0', sourceUrl: 'https://github.com/opencv/opencv', licenseUrl: 'https://github.com/opencv/opencv/blob/4.x/LICENSE' },
  { group: '本地组件', name: 'Send2Trash', version: '1.8.3', purpose: '将文件安全移动到系统回收站', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/arsenetar/send2trash', licenseUrl: 'https://github.com/arsenetar/send2trash/blob/main/LICENSE' },

];
