import os
import mimetypes
import traceback
import glob
import re
from typing import List
from fastapi import APIRouter, UploadFile, File, Form, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from core.config import get_config_data, save_config_data
from core.storage import save_temp_file
from core.tasks import load_tasks, save_tasks, create_task
from services.llm import process_image, process_word_definition, process_context_analysis
from core.vocabulary import merge_or_create_vocab, VOCAB_DIR, load_vocab

router = APIRouter()

@router.get("/api/config")
def get_config():
    """获取当前 LLM 配置信息"""
    config = get_config_data()
    return {
        "provider": config["provider"],
        "model": config["model"],
        "hasKey": config["hasKey"]
    }

@router.post("/api/config")
def update_config(provider: str = Form(...), model: str = Form(...), api_key: str = Form("")):
    """更新 LLM 配置信息"""
    save_config_data(provider, model, api_key)
    return {"status": "success", "message": "配置已保存"}


def process_task_background(task_id: str):
    """
    后台任务运行器：支持跳过已完成项实现断点续传。
    配合优化后的 llm.py，此处读取的原始字节（包括 HEIC）将被正确处理。
    """
    tasks = load_tasks()
    task = tasks.get(task_id)
    if not task: 
        return
    
    task["status"] = "processing"
    save_tasks(tasks)

    for sub in task["sub_tasks"]:
        if sub.get("status") == "completed": 
            continue
        
        try:
            if not os.path.exists(sub["path"]):
                raise FileNotFoundError(f"找不到本地文件: {sub['path']}")
                
            with open(sub["path"], "rb") as f: 
                image_bytes = f.read()
            
            mime = mimetypes.guess_type(sub["path"])[0] or "image/jpeg"
            reply = process_image(image_bytes, os.path.basename(sub["path"]), mime)
            
            sub["result"] = reply
            sub["status"] = "completed"
            sub.pop("error", None)
            task["completed"] += 1
            save_tasks(tasks)
            
        except Exception as e:
            print(f"\n❌ [后台任务] 任务 {task_id} 处理子项异常!")
            print(f"📄 异常文件: {sub.get('path')}")
            print(f"⚠️ 错误信息: {str(e)}")
            traceback.print_exc()
            sub["status"] = "failed"
            sub["error"] = str(e)
            task["status"] = "paused"
            save_tasks(tasks)
            return

    task["status"] = "finished"
    save_tasks(tasks)


@router.post("/api/upload_resource")
async def upload_resource(
    background_tasks: BackgroundTasks, 
    files: List[UploadFile] = File(...),
    taskName: str = Form(""),    
    startPage: int = Form(1)     
):
    """上传资源并创建处理任务，支持图片和 PDF"""
    sub_tasks_paths = []
    try:
        for file in files:
            bytes_data = await file.read()
            saved_path = save_temp_file(bytes_data, file.filename)
            
            if file.filename.lower().endswith(".pdf"):
                try:
                    from pdf2image import convert_from_path
                    pdf_images = convert_from_path(saved_path)
                    for i, img in enumerate(pdf_images):
                        img_path = f"{saved_path}_page_{i}.jpg"
                        img.save(img_path, "JPEG")
                        sub_tasks_paths.append(img_path)
                except Exception as pdf_error:
                    print(f"❌ PDF 解析失败: {pdf_error}")
                    raise Exception(f"PDF 解析失败，请检查服务器 poppler 配置: {str(pdf_error)}")
            else:
                sub_tasks_paths.append(saved_path)

        final_name = taskName.strip() if taskName.strip() else "资源解析任务"
        task_id = create_task(final_name, sub_tasks_paths, startPage)
        background_tasks.add_task(process_task_background, task_id)
        
        return {"status": "success", "task_id": task_id}
    except Exception as e:
        print(f"❌ 资源上传阶段异常: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/task/{task_id}")
def get_task_status(task_id: str):
    """获取指定任务的详细状态"""
    tasks = load_tasks()
    return tasks.get(task_id, {"error": "任务不存在"})

@router.post("/api/task/{task_id}/resume")
def resume_task(task_id: str, background_tasks: BackgroundTasks):
    """恢复执行已暂停的任务"""
    background_tasks.add_task(process_task_background, task_id)
    return {"status": "resumed"}

@router.get("/api/tasks")
def list_all_tasks():
    """获取所有任务的历史列表"""
    tasks_dict = load_tasks()
    task_list = []
    for task_id, task_info in tasks_dict.items():
        task_list.append({
            "id": task_id,
            "name": task_info.get("name", "未命名任务"),
            "status": task_info.get("status", "unknown"),
            "total": task_info.get("total", 0),
            "completed": task_info.get("completed", 0)
        })
    task_list.reverse()
    return {"status": "success", "tasks": task_list}

@router.get("/api/image")
def get_image(path: str):
    """根据路径返回图片文件，供前端预览使用"""
    abs_path = os.path.abspath(path)
    if os.path.exists(abs_path):
        return FileResponse(abs_path)
    return {"error": "图片文件不存在或已被清理"}

@router.delete("/api/task/{task_id}")
def delete_task(task_id: str):
    """删除任务记录"""
    tasks = load_tasks()
    if task_id in tasks:
        del tasks[task_id]
        save_tasks(tasks)
        return {"status": "success"}
    return {"error": "任务不存在"}

class RegenerateRequest(BaseModel):
    index: int 

@router.post("/api/task/{task_id}/regenerate")
def regenerate_task_item(task_id: str, req: RegenerateRequest, background_tasks: BackgroundTasks):
    """重新生成任务中特定的某一项（例如某张图片识别不满意时）"""
    tasks = load_tasks()
    task = tasks.get(task_id)
    if not task:
        return {"error": "任务不存在"}
        
    sub_tasks = task.get("sub_tasks", [])
    if req.index < 0 or req.index >= len(sub_tasks):
        return {"error": "参数错误，索引越界"}
        
    sub = sub_tasks[req.index]
    if sub.get("status") == "completed":
        task["completed"] = max(0, task.get("completed", 1) - 1)
        
    sub["status"] = "pending" 
    sub["result"] = None
    if "error" in sub:
        del sub["error"]
        
    task["status"] = "processing"
    save_tasks(tasks)
    
    background_tasks.add_task(process_task_background, task_id)
    return {"status": "success", "message": f"已将第 {req.index} 项加入重新生成队列"}

class VocabAddRequest(BaseModel):
    word: str
    context: str = ""
    source: str = ""
    fetch_llm: bool = False
    fetch_type: str = "all" 
    category: str = ""

@router.get("/api/vocabulary/categories")
def list_categories():
    """获取生词本下的所有子文件夹"""
    categories = []
    if os.path.exists(VOCAB_DIR):
        categories = [d for d in os.listdir(VOCAB_DIR) if os.path.isdir(os.path.join(VOCAB_DIR, d))]
    return {"status": "success", "categories": categories}

@router.post("/api/vocabulary/add")
def add_vocabulary(req: VocabAddRequest):
    """处理生词加入或合并"""
    try:
        llm_result = {}
        if req.fetch_llm:
            print(f"正在处理 {req.word} | 类型: {req.fetch_type} | 目录: {req.category}")            
            
            if req.fetch_type == "def" or not req.context:
                llm_result = process_word_definition(req.word)
            else:
                llm_result = process_context_analysis(req.word, req.context) 
        
        final_data = merge_or_create_vocab(req.word, req.context, req.source, llm_result, req.category)
        return {"status": "success", "data": final_data}
    except Exception as e:
        print(f"❌ 生词处理失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/vocabulary/list")
def list_vocabulary(category: str = ""):
    words = []
    safe_category = re.sub(r'[^\w\u4e00-\u9fa5\.-]+', '_', category.strip()) if category else ""
    target_dir = os.path.join(VOCAB_DIR, safe_category) if safe_category else VOCAB_DIR
    
    if os.path.exists(target_dir):
        files = glob.glob(f"{target_dir}/*.json")
        for f in files:
            word = os.path.basename(f).replace(".json", "")
            words.append(word)
    words.sort()
    return {"status": "success", "words": words}

@router.get("/api/vocabulary/detail/{word}")
def get_vocab_detail(word: str, category: str = ""):
    data = load_vocab(word, category)
    if not data:
        return {"error": "单词不存在或已删除"}
    return {"status": "success", "data": data}