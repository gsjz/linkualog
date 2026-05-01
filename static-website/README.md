# static-website

`static-website/` 是 Linkualog 的静态展示层。它读取仓库根目录 `data/` 下的 JSON 词条，生成 `docs/dictionary/` Markdown 页面，再用 Zensical 构建静态网站。

## 运行

建议环境：Python `3.13`、`uv`。

```bash
cd /path/to/linkualog/static-website
uv sync
make serve
```

默认参数：

- `PORT=6789`
- `DATA_DIR=../data`

显式指定：

```bash
make serve PORT=6789 DATA_DIR=../data
```

## 常用命令

```bash
make data                         # data/*.json -> docs/dictionary/
make build DATA_DIR=../data       # 构建到 site/
make clean                        # 清理 site/ 和 docs/dictionary/
```

## 部署

构建后把 `site/` 交给任意静态文件服务即可：

```bash
make build DATA_DIR=../data
```

输出目录：

```text
static-website/site/
```

仓库也保留了 `.github/workflows/deploy.yml`，会在 `main` 或 `master` 分支推送后构建并发布 GitHub Pages。

## 说明

- 真正的数据生成入口是 `hooks/build_dict.py`。
- `docs/dictionary/` 是生成目录，不建议手改。
- 当前导航在 `zensical.toml` 中预置了 `daily`、`cet`、`ielts`；新增分类后需要手动补导航。
