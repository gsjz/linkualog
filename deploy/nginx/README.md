# Nginx 反向代理示例

建议将 `master-server` 运行在仅本机可访问的端口，例如：

```bash
cp .env.domain.example .env
docker compose -f docker-compose.domain.yml up -d --build master-server
```

然后由 Nginx 把公开域名反向代理到 `127.0.0.1:18080`。

示例配置见 [linkualog.example.conf](linkualog.example.conf)。

如果当前服务器已经有私有域名配置，请保留在本地私有文件中，不要提交到仓库。
