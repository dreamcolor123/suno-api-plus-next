# Suno Cookie Extractor（浏览器插件）

Chrome / Edge 扩展：在你已登录 [suno.com](https://suno.com) 时，**一键提取**包含 `__client` 的 Cookie，用于 suno-api 管理后台「添加账号」。

## 安装（开发者模式）

1. 打开 Chrome / Edge
2. 地址栏进入：
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. 打开右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**
5. 选择本目录：`suno-cookie-extension`

## 使用

1. 浏览器打开并登录 [https://suno.com](https://suno.com)
2. 点击扩展图标
3. 点 **一键提取 Cookie**
4. 点 **复制**
5. 回到 suno-api 管理后台 → 账号池 → 添加账号 → 粘贴 Cookie

可选：在插件里填写管理后台地址（如 `http://38.47.121.78:3000`），点「打开管理后台」。

## 权限说明

- `cookies`：读取 suno.com / clerk.suno.com 下的登录 Cookie
- 不会上传你的 Cookie 到第三方服务器
- 数据仅保存在浏览器本地 storage（最近一次提取结果、后台地址）

## 打包分享（可选）

把 `suno-cookie-extension` 文件夹打成 zip，发给同事按上面「加载已解压的扩展程序」安装即可。
