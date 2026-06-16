# Word Studio Share

公开分享版词汇学习网页。别人打开一个网址即可使用，词库和学习记录保存在各自浏览器本地。

## 本地试运行

```bash
npm install
npm run build
npm start
```

启动后打开终端里显示的网址。默认端口来自 `PORT`，未设置时为 `8787`。

## 环境变量

复制 `.env.example` 为 `.env` 后填写：

```bash
DEEPSEEK_API_KEY=你的 DeepSeek key
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_BASE_URL=https://api.deepseek.com
AI_RATE_LIMIT_WINDOW_MS=3600000
AI_RATE_LIMIT_MAX=60
```

`AI_RATE_LIMIT_MAX=60` 表示每个 IP 每小时最多调用 60 次 AI 接口。导入、背词和普通页面不受这个限制。

## 部署到 Render 免费版

1. 把本目录上传到一个新的 GitHub 仓库。
2. 打开 Render，新建 Web Service，连接这个仓库。
3. 使用以下配置：
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Plan: Free
4. 在 Render 的 Environment Variables 里填写：
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_MODEL=deepseek-v4-pro`
   - `DEEPSEEK_BASE_URL=https://api.deepseek.com`
   - `AI_RATE_LIMIT_WINDOW_MS=3600000`
   - `AI_RATE_LIMIT_MAX=60`
5. 部署完成后，把 Render 给出的公开网址发给别人即可。

## 注意

- 不要上传 `.env`，里面有真实 API key。
- 上云前建议重新生成一个新的 DeepSeek API key，并停用曾经在聊天里发出来过的旧 key。
- Render 免费服务没人访问时会休眠，第一次打开可能会慢一点。
- 当前版本不做账号和云同步；每个用户的数据都只存在自己的浏览器里。
