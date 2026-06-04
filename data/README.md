# 历史记录备份（提交到 Git）

`mj-history-backup.json` 保存扩展内的 **下载记录** 与 **提示词查询记录** 快照。

## 更新备份并提交

1. 在 Midjourney 页面点击 **「导出历史备份」**，或打开批量页点击 **「导出历史备份」**。
2. 浏览器会下载 `mj-history-backup.json`（一般在「下载」文件夹）。
3. 用该文件 **覆盖** 本目录下的 `mj-history-backup.json`。
4. 提交 Git：

```powershell
git add data/mj-history-backup.json
git commit -m "chore: update IndexedDB history backup"
git push
```

也可运行（将下载目录中最新备份复制到此处）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\copy-backup-from-downloads.ps1
```

## 恢复

重新加载扩展后，会自动把仓库中的 `mj-history-backup.json` **合并导入** 到 IndexedDB（只追加/更新，不删除本地已有记录）。

若备份有更新，请先导出并覆盖本文件，再重新加载扩展。
