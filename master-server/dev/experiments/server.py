# server.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import json
from datetime import datetime

app = Flask(__name__)
CORS(app) 

@app.route('/api/sync', methods=['POST'])
def sync_data():
    try:
        data = request.get_json()
        
        print("=" * 50)
        print(f"[{datetime.now().strftime('%H:%M:%S')}] 收到来自前端的数据:")
        print(json.dumps(data, indent=2, ensure_ascii=False))
        print("=" * 50 + "\n")

        received_count = len(data.get('data', [])) if isinstance(data, dict) else 0

        return jsonify({
            "success": True,
            "message": "数据已成功接收 (Python/uv Backend)",
            "receivedCount": received_count
        }), 200

    except Exception as e:
        print(f"解析出错: {e}")
        return jsonify({"success": False, "message": "数据格式错误"}), 400

if __name__ == '__main__':
    port = 5000
    print(f"✅ Python 局域网后端已启动 (Powered by uv)")
    print(f"👉 监听端口: {port}")
    app.run(host='0.0.0.0', port=port)