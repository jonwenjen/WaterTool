// 在背景執行緒把檔案分段複製到 App 自己的儲存空間（OPFS）。
// 用同步存取控制代碼（createSyncAccessHandle）：Safari 15.2+、Chrome 102+ 都有；主執行緒的 createWritable 較新的瀏覽器才有。
//   收到 { file, dir, name } → 送出 { progress: 0–1 } … 最後 { done: true } 或 { error: { name, message } }
self.onmessage = async ({ data: { file, dir, name } }) => {
  let ah = null;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await (await root.getDirectoryHandle(dir, { create: true })).getFileHandle(name, { create: true });
    ah = await fh.createSyncAccessHandle();
    ah.truncate(0);
    const CH = 8 * 2 ** 20;
    for (let o = 0; o < file.size; o += CH) {
      const buf = new Uint8Array(await file.slice(o, Math.min(file.size, o + CH)).arrayBuffer());
      for (let w = 0; w < buf.length;) w += ah.write(buf.subarray(w), { at: o + w });
      self.postMessage({ progress: Math.min(1, (o + CH) / file.size) });
    }
    ah.flush();
    ah.close();
    ah = null;
    self.postMessage({ done: true });
  } catch (err) {
    try { if (ah) ah.close(); } catch { /* 已關閉 */ }
    self.postMessage({ error: { name: err.name, message: err.message } });
  }
};
