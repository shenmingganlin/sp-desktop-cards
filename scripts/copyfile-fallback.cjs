// copyfile-fallback.cjs — 只在打包时加载（npm run dist 通过 NODE_OPTIONS --require 注入）。
//
// 有些 Windows 机器上，安全软件会拦截 CopyFileW 复制 .exe，Node 的 fs.copyFile 于是报
// UNKNOWN(-4094)，electron-builder 复制 NSIS 的 elevate.exe 时就失败。读出来再写进去不受影响。
// 这里只在遇到这个错误时改用读写复制，其余情况照常走原来的 copyFile；打包产物不受影响。
const fs = require("node:fs");

const isBlocked = (error) => error && (error.code === "UNKNOWN" || error.errno === -4094);
const COPYFILE_EXCL = fs.constants.COPYFILE_EXCL;

function fallbackSync(src, dest, mode) {
  if (mode & COPYFILE_EXCL && fs.existsSync(dest)) {
    const error = new Error(`EEXIST: file already exists, copyfile '${src}' -> '${dest}'`);
    error.code = "EEXIST";
    throw error;
  }
  fs.writeFileSync(dest, fs.readFileSync(src));
  const { mode: perm, atime, mtime } = fs.statSync(src);
  fs.chmodSync(dest, perm);
  fs.utimesSync(dest, atime, mtime);
}

const copyFileSync = fs.copyFileSync;
fs.copyFileSync = function patchedCopyFileSync(src, dest, mode = 0) {
  try {
    return copyFileSync.call(fs, src, dest, mode);
  } catch (error) {
    if (!isBlocked(error)) throw error;
    return fallbackSync(src, dest, mode);
  }
};

const copyFile = fs.copyFile;
fs.copyFile = function patchedCopyFile(src, dest, mode, callback) {
  if (typeof mode === "function") {
    callback = mode;
    mode = 0;
  }
  copyFile.call(fs, src, dest, mode, (error) => {
    if (!isBlocked(error)) return callback(error);
    try {
      fallbackSync(src, dest, mode);
      callback(null);
    } catch (fallbackError) {
      callback(fallbackError);
    }
  });
};

const promiseCopyFile = fs.promises.copyFile;
fs.promises.copyFile = async function patchedPromiseCopyFile(src, dest, mode = 0) {
  try {
    return await promiseCopyFile.call(fs.promises, src, dest, mode);
  } catch (error) {
    if (!isBlocked(error)) throw error;
    return fallbackSync(src, dest, mode);
  }
};
