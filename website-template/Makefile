# ==========================================
# ⚙️ 全局配置区
# ==========================================
PORT ?= 6789  
DATA_DIR ?= ../data

# ==========================================
# 🚀 任务指令区
# ==========================================
.PHONY: data serve build clean

# 1. 数据转换步骤
data:
	@echo "⚙️  正在从 $(DATA_DIR) 目录拉取数据并生成页面..."
	DATA_DIR=$(DATA_DIR) uv run python hooks/build_dict.py

# 2. 启动服务（自动先执行 data）
serve: data
	@echo "🚀 正在 http://localhost:$(PORT) 启动 Zensical 本地服务..."
	uv run zensical serve -a localhost:$(PORT) > /dev/null

# 3. 构建静态文件（自动先执行 data）
build: data
	@echo "📦 正在构建 Zensical 静态网站..."
	uv run zensical build > /dev/null

# 4. 清理工作
clean:
	@echo "🧹 清理旧的构建文件和生成的页面..."
	rm -rf site
	rm -rf docs/dictionary