# Suno API Plus Next

非官方、可自托管的 Suno API 网关。本次干净历史版本由 `dreamcolor123` 维护，基于公开的 [`ShowSnowBlood/suno-api-plus`](https://github.com/ShowSnowBlood/suno-api-plus)，并继承 [`gcui-art/suno-api`](https://github.com/gcui-art/suno-api) 的相关实现。请查看 [`NOTICE`](./NOTICE) 和 [`LICENSE`](./LICENSE)。

> 只使用你有权使用的账号和内容。请遵守 Suno 服务条款、当地法律、验证码服务条款以及所有依赖的许可证。本项目与 Suno, Inc. 没有隶属关系。

## 功能概览

- 原生音乐生成、自定义模式、Cover、Extend、歌词、Clip 查询和元数据接口。
- OpenAI 兼容的 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 和计费接口。
- `basic`、`super`、`heavy` 账号池、额度刷新、账号 affinity 和全局并发限制。
- YesCaptcha/2Captcha，包含有限时限、服务健康检查和安全错误码。
- 短音频 Direct Upload，长音频 Studio Fast Upload，支持幂等、检查点和只读核对。
- Studio 高级分离、工程管理、Clip 下载；旧高级分离 WAV/render 下载接口明确返回 `410`。
- 管理后台：账号、API Key、验证码、计费、并发和生成诊断。

## 快速开始

### Docker Compose

```bash
git clone https://github.com/dreamcolor123/suno-api-plus-next.git
cd suno-api-plus-next
cp .env.example .env
# 编辑 .env，或创建 data/accounts.json 配置你自己的账号。
docker compose up --build -d
```

默认监听 `127.0.0.1:3000`。账号和任务数据持久化在 `./data`，必须妥善保护和备份。凭据只在运行时注入，不会作为 Docker build 参数写入镜像。

### 本地开发

需要 Node.js 20+、Python 3.10+、FFmpeg/FFprobe；启用浏览器验证码时还需要受支持的 Chromium 浏览器。

```bash
npm ci
python -m pip install -r requirements-fast-upload.txt
npm run dev
```

使用 `npm run build && npm run start` 验证生产模式。`npm test` 运行 Node 契约测试，`npm run test:python` 运行 Python 测试。

## 配置

复制 `.env.example` 并修改所有占位值。常用配置如下：

| 变量 | 作用 |
| --- | --- |
| `SUNO_COOKIE` | 仅建议本地开发使用的单账号 Cookie；生产环境优先使用后台账号池。 |
| `ACCOUNT_DATA_PATH` | 账号池 JSON 路径，默认 `./data/accounts.json`。 |
| `ACCOUNT_ENCRYPTION_KEY` | 加密保存的账号 Cookie；使用长随机值并规划轮换。 |
| `ADMIN_PASSWORD` | 管理后台密码，首次使用前必须设置。 |
| `API_KEY` / `SUNO_API_KEY` | 启用后保护 `/v1/*` 接口。 |
| `CAPTCHA_PROVIDER` | `auto`、`yescaptcha` 或 `2captcha`。 |
| `YESCAPTCHA_KEY`、`TWOCAPTCHA_KEY` | 仅在运行时提供的验证码服务密钥。 |
| `SUNO_PROXY_URL` | 可选的 Suno/Clerk 请求代理，不要使用不可信公共代理。 |
| `SUNO_STUDIO_FFMPEG_EXE`、`SUNO_STUDIO_FFPROBE_EXE` | 可选的媒体工具路径，Docker 已自带。 |
| `SUNO_FAST_UPLOAD_*` | Fast Upload 超时和有限并发控制。 |

后台可将账号池、API Key、验证码、计费和并发设置保存到数据目录。该目录不得提交到 Git。

## 鉴权与账号 affinity

启用 API Key 后，OpenAI 兼容接口接受 `Authorization: Bearer <API_KEY>`，也兼容 `x-api-key`/`api-key`。管理接口使用 `/admin` 建立的 `suno_admin_session` Cookie。

上传内容或私有 Studio 工程属于特定账号。响应可能在 JSON 和/或 `X-Suno-Account-Affinity` 中返回不透明的 `account_affinity`。后续操作必须原样传回，不要记录、发布、解码或替换 affinity token。

## 上传与 Fast Upload

`POST /api/upload_audio` 接收 multipart 字段 `audio_file`（也兼容 `file`），服务端使用 FFprobe 读取时长：

- `<=30.000` 秒：Direct Upload。
- `>30.000` 秒：Studio Fast Upload，不回退 Direct Upload。

长音频请发送稳定的 `Idempotency-Key`。已完成的 key 会复用结果；运行中的 key 返回冲突；结果不明时只能通过 `POST /api/upload_audio/reconcile` 只读核对，不能盲目重提。只有在能证明归属时才会清理临时分片和任务证据。

Fast Upload 只发布源码，不包含私有原生扩展或浏览器 Profile。公开 worker 使用运行时 Token、FFmpeg、预签名上传返回的全部字段、有限重试、原子检查点和 Studio 工程核对；不得用来绕过 Suno 访问控制或内容限制。

## Studio 高级分离

`POST /api/advanced_stems` 每次只提交一个 stem：

```json
{
  "audio_id": "<源 Clip ID>",
  "project_id": "<Studio 工程 ID>",
  "stem_name": "Bass",
  "account_affinity": "<不透明 affinity>"
}
```

该接口复刻 Studio 的分离请求并返回 Provider 结果。使用 Studio 工程、Downbeats 和保存接口建立工程上下文；单 Clip 下载使用 `POST /api/studio/clip/{clip_id}/download`，节拍信息使用 `GET /api/studio/clip/{clip_id}/downbeats`。旧 `/api/advanced_stems/wav` 与 `/api/advanced_stems/render` 因依赖不可用的旧下载链路，固定返回 HTTP `410`。

桌面 Runtime 的自动多阶段 WAV/ZIP 编排不属于本仓库。API Plus 提供底层接口，调用方负责自己的流程和产物存储。

## OpenAI 兼容接口

```bash
curl "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY"

curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"suno-music","messages":[{"role":"user","content":"一首关于夜行列车的动感合成器流行歌曲"}]}'
```

模型目录提供 `suno-music`、`suno-v5.5`、`suno-v5`、`suno-v4.5+` 等稳定别名和旧别名。未知模型 ID 会透传，以便兼容新的 Suno 版本。`/v1/images/generations` 和 `/v1/videos` 当前返回有明确说明的 `501`。

## 原生接口

交互式 Swagger 页面位于 `/docs`，当前契约包括：

- 生成：`/api/generate`、`/api/custom_generate`、`/api/cover`、`/api/extend_audio`、`/api/generate_lyrics`、`/api/generate_stems`、`/api/concat`。
- 查询：`/api/get`、`/api/get_limit`、`/api/get_aligned_lyrics`、`/api/clip`、`/api/persona`、`/api/voices`。
- 上传和元数据：`/api/upload_audio`、`/api/upload_audio/reconcile`、`/api/clip/{clip_id}/metadata`、`/api/clip/{clip_id}/download`。
- Studio：工程加载、创建/加载、保存、归档、Downbeats、工程列表和 Studio Clip 下载。
- 高级分离：`/api/advanced_stems` 及明确返回 `410` 的旧接口。
- 管理：账号、验证/刷新、验证码、API Key、计费、并发、歌曲和后台生成。

请求/响应 schema 见 [`src/app/docs/swagger-suno-api.json`](./src/app/docs/swagger-suno-api.json)。`public/swagger-suno-api.json` 是由该文件生成的副本，必须保持一致。

## 安全清单

- `.env`、`data/`、日志、PID、浏览器 Profile、Token 文件、生成音频和备份不得进入 Git。
- 对外提供服务时使用 HTTPS 或私有反向代理，参考 [`deploy/HTTPS.md`](./deploy/HTTPS.md)。
- 设置强后台密码、加密密钥和 API Key；不要在活动上传期间随意轮换。
- 限制账号池文件和产物目录的文件权限。
- 日志和问题报告中不得出现 Suno Cookie、验证码密钥、affinity token 或签名 URL。
- 不要把公共演示服务或第三方代理当作账号存储。

## 从 `suno-api-plus` 迁移

本仓库使用干净 Git 历史，不是旧仓库 Git remote 的直接替换。只迁移你明确需要的运行配置到 `data/`，不要复制 `.env`、日志、`.next`、`node_modules`、浏览器 Profile 或旧 Fast Upload 私有 Runtime。客户端需要注意：

1. 旧高级分离 WAV/render 下载接口现在返回 `410`，请改用 Studio 工程和 Clip 下载接口。
2. 长音频上传应使用 `Idempotency-Key`，以便可靠复用和核对。
3. 上传/私有操作必须保留响应中的账号 affinity。
4. Fast Upload 只使用公开 Python worker，不支持私有原生扩展。
5. `/api/generate_lyrics` 已自包含，直接调用 Suno 原生歌词接口。

## 开发与测试

```bash
npm test
npm run test:python
npm run typecheck
npm run build
```

测试只使用契约和合成 fixture，不包含真实 Cookie/Provider 密钥，也不会调用真实 Suno。

## 许可证与致谢

本项目使用 LGPL-3.0-or-later。重新分发时请保留许可证和版权声明。上游致谢：`gcui.ai/suno-api`、`ShowSnowBlood/suno-api-plus`。当前修改和源码版 Fast Upload 由 `dreamcolor123` 维护，详见 [`NOTICE`](./NOTICE)。
