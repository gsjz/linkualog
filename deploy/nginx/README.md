# Nginx 反向代理

这里放的是官方部署方式的 Nginx 示例。Compose 服务只监听本机端口，再由 Nginx 对外提供域名访问。

## 启动服务

在仓库根目录准备部署配置：

```bash
cd /path/to/linkualog
cp .env.example .env
# 填写 MASTER_SERVER_LLM_API_KEY
./deploy.sh master-server knotodo
```

`docker-compose.yml` 默认暴露：

- `127.0.0.1:18080` -> Linkualog 前端和 API
- `127.0.0.1:18081` -> Linkualog 后端同服务端口
- `127.0.0.1:18082` -> KnoTodo `/todo`

## 配置 Nginx

参考：

```text
deploy/nginx/linkualog.example.conf
```

核心反代目标：

```nginx
proxy_pass http://127.0.0.1:18080;
```

KnoTodo 使用同一域名的 `/todo`：

```nginx
location ^~ /todo {
    proxy_pass http://127.0.0.1:18082;
}
```

把示例里的 `server_name app.example.com;` 改成自己的域名后，放到服务器的 Nginx 配置目录并 reload。

## 注意

- 部署统一使用 `./deploy.sh` 和 `docker-compose.yml`。
- 私有域名配置不要提交到仓库。
- 本目录下的 `*.private.conf` 已被 `.gitignore` 忽略，可用于保存服务器本地配置。
- 如果还要同时部署 QQ bot，直接运行 `./deploy.sh`。
