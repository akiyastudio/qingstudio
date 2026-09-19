const FRAME_RUNTIME_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.m4v', '.mkv', '.webm', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm',
  '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw',
]);

const optionValue = (args, option) => {
  let result = '';
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '');
    if (value === option && index + 1 < args.length) result = String(args[index + 1] || '');
    else if (value.startsWith(`${option}=`)) result = value.slice(option.length + 1);
  }
  return result;
};

const renameNeedsFrameRuntime = (args, { fs, path }) => {
  for (const option of ['--folder_a', '--folder_b']) {
    const directory = optionValue(args, option);
    if (!directory) continue;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    if (entries.some(entry => entry.isFile() && FRAME_RUNTIME_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) return true;
  }
  return false;
};

module.exports = { FRAME_RUNTIME_EXTENSIONS, renameNeedsFrameRuntime };
